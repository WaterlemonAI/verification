import { createHash, randomUUID } from 'node:crypto';
import { TableClient, odata } from '@azure/data-tables';
import { ContainerAppsManagedIdentityCredential } from './azure-managed-identity.mjs';

const MILLION = 1_000_000;
const MAX_MICROS = 9_000_000_000_000_000;
const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const creditRowKey = (workspaceId, idempotencyKey) => idempotencyKey
  ? `credit-${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex')}`
  : `credit-${Date.now()}-${randomUUID()}`;

export function moneyMicros(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(text)) throw new Error('Amount must be a non-negative decimal with at most six places.');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * MILLION + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(result) || result > MAX_MICROS) throw new Error('Amount is too large.');
  return result;
}

export function moneyText(micros) {
  const sign = micros < 0 ? '-' : '';
  const absolute = Math.abs(micros);
  return `${sign}${Math.floor(absolute / MILLION)}.${String(absolute % MILLION).padStart(6, '0')}`;
}

function defaultAccount(workspaceId, managedCustomer) {
  return {
    partitionKey: `usage-${workspaceId}`, rowKey: 'account',
    mode: managedCustomer ? 'prepaid' : 'postpay', currency: 'USD',
    allowedModulesJson: JSON.stringify(managedCustomer ? [] : ['*']),
    ratesJson: '{}', countsJson: '{}', balanceMicros: '0', spentMicros: '0',
    chargedCalls: 0, updatedAt: now()
  };
}

export function validateUsagePolicy(input, moduleIds) {
  const mode = String(input?.mode || '');
  const currency = String(input?.currency || '');
  if (!['prepaid', 'postpay'].includes(mode)) throw new Error('Billing mode must be prepaid or postpay.');
  if (!['USD', 'AED'].includes(currency)) throw new Error('Currency must be USD or AED.');
  const allowedModules = Array.isArray(input?.allowed_modules) ? [...new Set(input.allowed_modules.map(String))] : [];
  if (allowedModules.some((id) => !moduleIds.has(id))) throw new Error('An unknown module was selected.');
  const rates = {};
  for (const [id, tiers] of Object.entries(input?.rates || {})) {
    if (!moduleIds.has(id) || !Array.isArray(tiers) || !tiers.length || tiers.length > 20) throw new Error(`Invalid rate tiers for ${id}.`);
    let previous = 0;
    rates[id] = tiers.map((tier, index) => {
      const upTo = tier.up_to === null || tier.up_to === '' ? null : Number(tier.up_to);
      if ((upTo === null && index !== tiers.length - 1) ||
          (upTo !== null && (!Number.isSafeInteger(upTo) || upTo <= previous || upTo > 1_000_000_000))) {
        throw new Error(`Rate tier bounds for ${id} must increase and end with a blank upper bound.`);
      }
      if (upTo !== null) previous = upTo;
      return { upTo, priceMicros: moneyMicros(tier.price) };
    });
    if (rates[id].at(-1).upTo !== null) throw new Error(`The last rate tier for ${id} must have a blank upper bound.`);
  }
  return { mode, currency, allowedModules, rates };
}

function tierPrice(tiers, ordinal) {
  return (tiers || []).find((tier) => tier.upTo === null || ordinal <= tier.upTo)?.priceMicros || 0;
}

function publicAccount(account) {
  return {
    workspace_id: account.partitionKey.slice(6), mode: account.mode, currency: account.currency,
    allowed_modules: JSON.parse(account.allowedModulesJson),
    rates: Object.fromEntries(Object.entries(JSON.parse(account.ratesJson)).map(([id, tiers]) => [id,
      tiers.map((tier) => ({ up_to: tier.upTo, price: moneyText(tier.priceMicros) }))])),
    counts: JSON.parse(account.countsJson), balance: moneyText(Number(account.balanceMicros)),
    spent: moneyText(Number(account.spentMicros)), charged_calls: account.chargedCalls,
    updated_at: account.updatedAt
  };
}

function callRow(workspaceId, { transactionId, keyId = '', moduleIds, method, path, responseCode = 0, costMicros = 0, breakdown = [], state = 'started' }) {
  const timestamp = now();
  return {
    partitionKey: `usage-${workspaceId}`,
    rowKey: `call-${String(9_999_999_999_999 - Date.now()).padStart(13, '0')}-${transactionId}`,
    transactionId, keyId, moduleIdsJson: JSON.stringify(moduleIds), method, path,
    responseCode, costMicros: String(costMicros), breakdownJson: JSON.stringify(breakdown), state,
    startedAt: timestamp, completedAt: responseCode ? timestamp : ''
  };
}

function publicCall(row) {
  return {
    transaction_id: row.transactionId, date_time: row.startedAt, completed_at: row.completedAt || null,
    key_id: row.keyId, modules: JSON.parse(row.moduleIdsJson), method: row.method, path: row.path,
    response_code: row.responseCode || null, cost: moneyText(Number(row.costMicros)),
    breakdown: JSON.parse(row.breakdownJson), state: row.state
  };
}

function applyAdmission(account, moduleIds) {
  const allowed = JSON.parse(account.allowedModulesJson);
  if (moduleIds.some((id) => !allowed.includes('*') && !allowed.includes(id))) return { denied: 403, reason: 'This module is not enabled for this customer.' };
  const rates = JSON.parse(account.ratesJson);
  const counts = JSON.parse(account.countsJson);
  const breakdown = moduleIds.map((id) => {
    const ordinal = (counts[id] || 0) + 1;
    return { module: id, hit: ordinal, cost: tierPrice(rates[id], ordinal) };
  });
  const costMicros = breakdown.reduce((sum, item) => sum + item.cost, 0);
  if (!Number.isSafeInteger(costMicros) || Number(account.spentMicros) + costMicros > MAX_MICROS) throw new Error('usage_meter_limit');
  if (account.mode === 'prepaid' && Number(account.balanceMicros) < costMicros) return { denied: 402, reason: 'Insufficient prepaid credit.' };
  for (const item of breakdown) counts[item.module] = item.hit;
  return {
    costMicros,
    breakdown: breakdown.map((item) => ({ module: item.module, hit: item.hit, cost: moneyText(item.cost) })),
    account: { ...account, countsJson: JSON.stringify(counts),
      balanceMicros: account.mode === 'prepaid' ? String(Number(account.balanceMicros) - costMicros) : account.balanceMicros,
      spentMicros: String(Number(account.spentMicros) + costMicros), chargedCalls: account.chargedCalls + 1, updatedAt: now() }
  };
}

export class MemoryCustomerUsageStore {
  constructor() { this.accounts = new Map(); this.rows = new Map(); this.creditRows = new Map(); }
  async account(workspaceId, managedCustomer = false) {
    if (!this.accounts.has(workspaceId)) this.accounts.set(workspaceId, defaultAccount(workspaceId, managedCustomer));
    return publicAccount(this.accounts.get(workspaceId));
  }
  async configure(workspaceId, policy, managedCustomer = false) {
    await this.account(workspaceId, managedCustomer);
    const current = this.accounts.get(workspaceId);
    if (current.currency !== policy.currency && (current.chargedCalls || Number(current.balanceMicros))) throw new Error('Currency cannot change after credit or billable usage.');
    const next = { ...current, mode: policy.mode, currency: policy.currency, allowedModulesJson: JSON.stringify(policy.allowedModules), ratesJson: JSON.stringify(policy.rates), updatedAt: now() };
    this.accounts.set(workspaceId, next);
    return publicAccount(next);
  }
  async addCredit(workspaceId, amountMicros, managedCustomer = false, { idempotencyKey = '', actor = '' } = {}) {
    await this.account(workspaceId, managedCustomer);
    const current = this.accounts.get(workspaceId);
    const id = creditRowKey(workspaceId, idempotencyKey);
    const previous = this.creditRows.get(id);
    if (previous) {
      if (previous.amount !== moneyText(amountMicros)) throw new Error('Idempotency key was already used for a different credit amount.');
      return publicAccount(current);
    }
    if (Number(current.balanceMicros) + amountMicros > MAX_MICROS) throw new Error('Credit balance limit exceeded.');
    const next = { ...current, balanceMicros: String(Number(current.balanceMicros) + amountMicros), updatedAt: now() };
    this.accounts.set(workspaceId, next);
    const credit = { id, workspace_id: workspaceId, amount: moneyText(amountMicros), currency: current.currency, credited_at: now(), actor };
    this.creditRows.set(credit.id, credit);
    return publicAccount(next);
  }
  async credits(workspaceId, limit = 100) {
    return [...this.creditRows.values()].filter((row) => row.workspace_id === workspaceId)
      .sort((a, b) => b.credited_at.localeCompare(a.credited_at)).slice(0, limit);
  }
  async admit(workspaceId, details, managedCustomer = false) {
    await this.account(workspaceId, managedCustomer);
    const current = this.accounts.get(workspaceId);
    const decision = applyAdmission(current, details.moduleIds);
    const row = callRow(workspaceId, { ...details, responseCode: decision.denied || 0,
      costMicros: decision.costMicros || 0, breakdown: decision.breakdown || [], state: decision.denied ? 'denied' : 'started' });
    if (!decision.denied) this.accounts.set(workspaceId, decision.account);
    this.rows.set(row.transactionId, row);
    return decision.denied ? { allowed: false, statusCode: decision.denied, reason: decision.reason } : { allowed: true, cost: moneyText(decision.costMicros), logKey: row.rowKey };
  }
  async record(workspaceId, details, responseCode) {
    const row = callRow(workspaceId, { ...details, responseCode, state: 'completed' });
    this.rows.set(row.transactionId, row);
  }
  async complete(workspaceId, logKey, responseCode) {
    const row = [...this.rows.values()].find((item) => item.rowKey === logKey);
    if (!row || row.partitionKey !== `usage-${workspaceId}` || row.state !== 'started') return;
    this.rows.set(row.transactionId, { ...row, responseCode, state: 'completed', completedAt: now() });
  }
  async logs(workspaceId, limit = 100) {
    return [...this.rows.values()].filter((row) => row.partitionKey === `usage-${workspaceId}`)
      .sort((a, b) => a.rowKey.localeCompare(b.rowKey)).slice(0, limit).map(publicCall);
  }
}

export class AzureCustomerUsageStore {
  constructor({ tableClient } = {}) {
    const url = process.env.ADVERSE_MEDIA_REPORT_TABLE_URL;
    this.table = tableClient || (url ? new TableClient(url, process.env.ADVERSE_MEDIA_REPORT_TABLE || 'AdverseMediaReports', new ContainerAppsManagedIdentityCredential()) : null);
  }
  ensureTable() { if (!this.table) throw new Error('usage_meter_unavailable'); return this.table; }
  async getOrCreate(workspaceId, managedCustomer) {
    const table = this.ensureTable();
    const partition = `usage-${workspaceId}`;
    try { return await table.getEntity(partition, 'account'); }
    catch (error) { if (error.statusCode !== 404) throw error; }
    try { await table.createEntity(defaultAccount(workspaceId, managedCustomer)); }
    catch (error) { if (error.statusCode !== 409) throw error; }
    return table.getEntity(partition, 'account');
  }
  async account(workspaceId, managedCustomer = false) { return publicAccount(await this.getOrCreate(workspaceId, managedCustomer)); }
  async mutate(workspaceId, managedCustomer, build) {
    const table = this.ensureTable();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.getOrCreate(workspaceId, managedCustomer);
      const { next, row } = build(current);
      try {
        const { etag, timestamp, ...entity } = next;
        const actions = [['update', entity, 'Replace', { etag: current.etag }]];
        if (row) actions.push(['create', row]);
        await table.submitTransaction(actions);
        return { next, row };
      } catch (error) {
        if (![409, 412].includes(error.statusCode) || attempt === 7) throw error;
      }
    }
  }
  async configure(workspaceId, policy, managedCustomer = false) {
    const { next } = await this.mutate(workspaceId, managedCustomer, (current) => {
      if (current.currency !== policy.currency && (current.chargedCalls || Number(current.balanceMicros))) throw new Error('Currency cannot change after credit or billable usage.');
      return { next: { ...current, mode: policy.mode, currency: policy.currency,
        allowedModulesJson: JSON.stringify(policy.allowedModules), ratesJson: JSON.stringify(policy.rates), updatedAt: now() } };
    });
    return publicAccount(next);
  }
  async addCredit(workspaceId, amountMicros, managedCustomer = false, { idempotencyKey = '', actor = '' } = {}) {
    const table = this.ensureTable();
    const rowKey = creditRowKey(workspaceId, idempotencyKey);
    const partitionKey = `usage-${workspaceId}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (idempotencyKey) {
        try {
          const previous = await table.getEntity(partitionKey, rowKey);
          if (Number(previous.amountMicros) !== amountMicros) throw new Error('Idempotency key was already used for a different credit amount.');
          return this.account(workspaceId, managedCustomer);
        } catch (error) { if (error.statusCode !== 404) throw error; }
      }
      const current = await this.getOrCreate(workspaceId, managedCustomer);
      if (Number(current.balanceMicros) + amountMicros > MAX_MICROS) throw new Error('Credit balance limit exceeded.');
      const next = { ...current, balanceMicros: String(Number(current.balanceMicros) + amountMicros), updatedAt: now() };
      const { etag, timestamp, ...entity } = next;
      try {
        await table.submitTransaction([
          ['update', entity, 'Replace', { etag: current.etag }],
          ['create', { partitionKey, rowKey, amountMicros: String(amountMicros), creditedAt: now(), actor }]
        ]);
        return publicAccount(next);
      } catch (error) {
        if (![409, 412].includes(error.statusCode) || attempt === 7) throw error;
      }
    }
  }
  async credits(workspaceId, limit = 100) {
    const partition = `usage-${workspaceId}`;
    const rows = this.ensureTable().listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition} and RowKey ge ${'credit-'} and RowKey lt ${'credits-'}` } });
    const currency = (await this.account(workspaceId)).currency;
    const result = [];
    for await (const row of rows) {
      result.push({ id: row.rowKey, workspace_id: workspaceId, amount: moneyText(Number(row.amountMicros)),
        currency, credited_at: row.creditedAt, actor: row.actor || '' });
    }
    return result.sort((a, b) => b.credited_at.localeCompare(a.credited_at)).slice(0, limit);
  }
  async admit(workspaceId, details, managedCustomer = false) {
    const table = this.ensureTable();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.getOrCreate(workspaceId, managedCustomer);
      const decision = applyAdmission(current, details.moduleIds);
      const row = callRow(workspaceId, { ...details, responseCode: decision.denied || 0,
        costMicros: decision.costMicros || 0, breakdown: decision.breakdown || [], state: decision.denied ? 'denied' : 'started' });
      try {
        if (decision.denied) await table.createEntity(row);
        else {
          const { etag, timestamp, ...entity } = decision.account;
          await table.submitTransaction([['update', entity, 'Replace', { etag: current.etag }], ['create', row]]);
        }
        return decision.denied ? { allowed: false, statusCode: decision.denied, reason: decision.reason } : { allowed: true, cost: moneyText(decision.costMicros), logKey: row.rowKey };
      } catch (error) {
        if (![409, 412].includes(error.statusCode) || attempt === 7) throw error;
      }
    }
  }
  async record(workspaceId, details, responseCode) {
    await this.ensureTable().createEntity(callRow(workspaceId, { ...details, responseCode, state: 'completed' }));
  }
  async complete(workspaceId, logKey, responseCode) {
    const table = this.ensureTable();
    const partition = `usage-${workspaceId}`;
    const row = await table.getEntity(partition, logKey);
    if (row.state === 'started') await table.updateEntity({ partitionKey: partition, rowKey: logKey, responseCode, state: 'completed', completedAt: now() }, 'Merge', { etag: row.etag });
  }
  async logs(workspaceId, limit = 100) {
    const partition = `usage-${workspaceId}`;
    const rows = this.ensureTable().listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition} and RowKey ge ${'call-'} and RowKey lt ${'calm-'}` } });
    const result = [];
    for await (const row of rows) { result.push(publicCall(row)); if (result.length >= limit) break; }
    return result;
  }
}

export function createCustomerUsageStore() {
  return process.env.NODE_ENV === 'test' ? new MemoryCustomerUsageStore() : new AzureCustomerUsageStore();
}
