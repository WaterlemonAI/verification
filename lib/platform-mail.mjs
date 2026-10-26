import nodemailer from 'nodemailer';

const FROM = 'KYCProbe <notify@kycprobe.com>';
const REPLY_TO = 'notify@ai7lab.net';

export function createPlatformMailer({
  host = process.env.PLATFORM_SMTP_HOST || 'smtpout.secureserver.net',
  port = Number(process.env.PLATFORM_SMTP_PORT || 465),
  user = process.env.PLATFORM_SMTP_USER || 'notify@kycprobe.com',
  password = process.env.PLATFORM_SMTP_PASSWORD || '',
  transportFactory = nodemailer.createTransport
} = {}) {
  const configured = Boolean(password && host && user && port === 465);
  const transport = configured ? transportFactory({
    host, port, secure: true,
    auth: { user, pass: password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true
  }) : null;

  async function send({ to, subject, text }) {
    if (!transport) throw new Error('platform_email_unavailable');
    await transport.sendMail({ from: FROM, sender: user, replyTo: REPLY_TO, to, subject, text });
  }

  return {
    configured,
    async sendInvitation({ to, url, customerName, hours }) {
      await send({ to, subject: 'Set up your KYCProbe workspace',
        text: `You have been invited as the administrator of the ${customerName} KYCProbe workspace.\n\nOpen this one-time link to set your password (valid for ${hours} hours):\n${url}\n\nAfter signing in, create and manage API keys from Account settings. No API key is included in this email.\n\nIf you did not expect this invitation, ignore this message or reply to notify@ai7lab.net.\n\nKYCProbe by AI7Lab` });
    },
    async sendPasswordReset({ to, url, minutes }) {
      await send({ to, subject: 'Reset your KYCProbe password',
        text: `A password reset was requested for your KYCProbe account.\n\nOpen this link to set a new password (valid for ${minutes} minutes):\n${url}\n\nIf you did not request this, you can ignore this message. No password was changed.\n\nKYCProbe by AI7Lab` });
    },
    async sendSecurityAlert({ to, event }) {
      await send({ to, subject: 'KYCProbe account security notice',
        text: `Your KYCProbe account password was ${event}. If you did not make this change, reply to notify@ai7lab.net immediately.\n\nKYCProbe by AI7Lab` });
    },
    async sendTest({ to }) {
      await send({ to, subject: 'KYCProbe email test',
        text: 'This is a test of KYCProbe platform email. Replies go to notify@ai7lab.net.\n\nKYCProbe by AI7Lab' });
    }
  };
}
