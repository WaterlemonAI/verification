import { moneyMicros, moneyText } from './customer-usage.mjs';

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const LOW_BALANCE_MICROS = { USD: moneyMicros('5'), AED: moneyMicros('18.3625') };

function completedDubaiDay(at) {
  const local = new Date(at.getTime() + DUBAI_OFFSET_MS);
  if (local.getUTCHours() < 1) return null;
  return new Date(local.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function runBillingNotifications({ store, usageStore, mailer, at = new Date() }) {
  if (!mailer.configured) throw new Error('platform_email_unavailable');
  const usageDate = completedDubaiDay(at);
  const result = { customers: 0, queued: 0, sent: 0, failed: 0 };
  for (const customer of await store.listCustomers()) {
    if (customer.status !== 'active' || !customer.adminEmail) continue;
    result.customers++;
    try {
      const account = await usageStore.account(customer.id, true);
      if (account.mode === 'prepaid' && moneyMicros(account.balance) < LOW_BALANCE_MICROS[account.currency]) {
        const latestCredit = (await usageStore.credits(customer.id, 100)).find((row) => row.kind === 'credit');
        result.queued += Number(await usageStore.queueNotification(customer.id,
          `low-${latestCredit?.id.slice(7) || 'initial'}`, 'low_credit'));
      }
      if (usageDate) {
        result.queued += Number(await usageStore.queueNotification(customer.id,
          `daily-${usageDate}`, 'daily_usage', { usageDate }));
      }
      for (const notice of await usageStore.pendingNotifications(customer.id)) {
        const key = notice.rowKey.slice('notice-'.length);
        if (!await usageStore.claimNotification(customer.id, key, at)) continue;
        try {
          if (notice.kind === 'low_credit') {
            const current = await usageStore.account(customer.id, true);
            if (current.mode === 'prepaid' && moneyMicros(current.balance) < LOW_BALANCE_MICROS[current.currency]) {
              await mailer.sendLowCredit({ to: customer.adminEmail, balance: current.balance, currency: current.currency });
            }
          } else if (notice.kind === 'credit_added') {
            await mailer.sendCreditAdded({ to: customer.adminEmail, amount: moneyText(Number(notice.amountMicros)),
              balance: moneyText(Number(notice.balanceMicros)), currency: notice.currency });
          } else if (notice.kind === 'daily_usage') {
            await mailer.sendDailyUsage({ to: customer.adminEmail,
              usage: await usageStore.dailyUsage(customer.id, notice.usageDate) });
          } else {
            throw new Error('billing_notification_kind_invalid');
          }
          await usageStore.markNotificationSent(customer.id, key);
          result.sent++;
        } catch (error) {
          await usageStore.releaseNotification(customer.id, key);
          result.failed++;
        }
      }
    } catch (error) { result.failed++; }
  }
  return result;
}
