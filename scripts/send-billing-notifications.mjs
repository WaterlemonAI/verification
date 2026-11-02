import { createStore } from '../lib/api-store.mjs';
import { createCustomerUsageStore } from '../lib/customer-usage.mjs';
import { createPlatformMailer } from '../lib/platform-mail.mjs';
import { runBillingNotifications } from '../lib/billing-notifications.mjs';

try {
  const result = await runBillingNotifications({ store: createStore(), usageStore: createCustomerUsageStore(),
    mailer: createPlatformMailer() });
  console.info('billing_notification_counts', JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  console.warn('billing_notification_run_failed', error.message);
  process.exitCode = 1;
}
