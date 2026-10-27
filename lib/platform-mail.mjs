import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

const FROM = 'KYCProbe <notify@kycprobe.com>';
const REPLY_TO = 'notify@ai7lab.net';
const LOGO_CID = 'kycprobe-dark-logo@kycprobe.com';
const LOGO = readFileSync(new URL('../site/assets/kycprobe-logo-dark.png', import.meta.url));
const LINKS = [
  ['Website', 'https://kycprobe.com/'],
  ['Developer portal', 'https://app.kycprobe.com/login'],
  ['Terms', 'https://kycprobe.com/terms'],
  ['Contact', 'https://www.ai7lab.net/contact']
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeActionUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://app.kycprobe.com' || url.username || url.password) throw new Error('platform_email_invalid_action_url');
  return url.href;
}

function actionButton(label, href) {
  const url = escapeHtml(href);
  const title = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 24px"><tr><td align="center" bgcolor="#342bb1" style="border-radius:8px;background:#342bb1">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:244px" arcsize="16%" stroke="f" fillcolor="#342bb1"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${title}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${url}" style="display:inline-block;min-width:204px;padding:15px 20px;border-radius:8px;background:#342bb1;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:18px;text-align:center;text-decoration:none">${title}</a><!--<![endif]-->
</td></tr></table>`;
}

function renderEmail({ eyebrow, title, intro, body, action, note }) {
  const footerLinks = LINKS.map(([label, url]) => `<a href="${escapeHtml(url)}" style="color:#4d5780;text-decoration:underline">${escapeHtml(label)}</a>`).join(' &nbsp;&nbsp; ');
  const actionHtml = action ? `${actionButton(action.label, action.url)}<p style="margin:0 0 26px;color:#68728b;font-size:12px;line-height:19px">Button not working? Copy this link into your browser:<br><a href="${escapeHtml(action.url)}" style="color:#342bb1;word-break:break-all">${escapeHtml(action.url)}</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#eef1f7;color:#14213d;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef1f7" style="background:#eef1f7"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dfe4ee;border-radius:12px">
<tr><td style="padding:30px 36px 24px;border-bottom:3px solid #342bb1"><img src="cid:${LOGO_CID}" width="210" height="77" alt="KYCProbe by AI7Lab" style="display:block;width:210px;height:auto;border:0;color:#151750;font-size:19px;font-weight:bold"></td></tr>
<tr><td style="padding:34px 36px 30px"><p style="margin:0 0 12px;color:#342bb1;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase">${escapeHtml(eyebrow)}</p>
<h1 style="margin:0 0 18px;color:#111c36;font-size:27px;line-height:34px;font-weight:700">${escapeHtml(title)}</h1>
<p style="margin:0 0 16px;color:#34415c;font-size:15px;line-height:24px">${escapeHtml(intro)}</p>
<p style="margin:0;color:#34415c;font-size:15px;line-height:24px">${escapeHtml(body)}</p>
${actionHtml}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f6fb" style="background:#f4f6fb;border-left:3px solid #fac52a"><tr><td style="padding:14px 16px;color:#3b4966;font-size:13px;line-height:20px">${escapeHtml(note)}</td></tr></table></td></tr>
<tr><td style="padding:24px 36px 30px;border-top:1px solid #e7ebf3;color:#65718c;font-size:12px;line-height:21px"><p style="margin:0 0 10px;font-weight:700;color:#263358">KYCProbe by AI7Lab UAE</p><p style="margin:0 0 14px">${footerLinks}</p><p style="margin:0">Questions? Reply to this email. Please never send a password or API key by email.</p></td></tr></table>
</td></tr></table></body></html>`;
}

function textFooter() {
  return '\n\nKYCProbe by AI7Lab UAE\nWebsite: https://kycprobe.com/\nDeveloper portal: https://app.kycprobe.com/login\nTerms: https://kycprobe.com/terms\nContact: https://www.ai7lab.net/contact\nQuestions? Reply to this email. Never send a password or API key by email.';
}

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

  async function send({ to, subject, text, design }) {
    if (!transport) throw new Error('platform_email_unavailable');
    await transport.sendMail({ from: FROM, sender: user, replyTo: REPLY_TO, to, subject, text: text + textFooter(),
      html: renderEmail(design), attachments: [{ filename: 'kycprobe-logo-dark.png', content: LOGO, cid: LOGO_CID, contentDisposition: 'inline' }] });
  }

  return {
    configured,
    async sendInvitation({ to, url, customerName, hours }) {
      const link = safeActionUrl(url);
      const name = String(customerName || 'your');
      await send({ to, subject: 'Set up your KYCProbe workspace',
        text: `You have been invited to administer the ${name} workspace on KYCProbe.\n\nSet your password with this one-time link (valid for ${hours} hours):\n${link}\n\nAfter signing in, manage API keys in Account settings. No API key is included in this email.\n\nIf you were not expecting this invitation, ignore it or reply to notify@ai7lab.net.`,
        design: { eyebrow: 'Workspace invitation', title: 'Your workspace is ready',
          intro: `You have been invited to administer the ${name} workspace on KYCProbe.`,
          body: 'Set your password to sign in. You can manage your API keys from Account settings after setup.',
          action: { label: 'Set up your account', url: link },
          note: `This one-time link expires in ${hours} hours. No API key is included. If you were not expecting this invitation, you can ignore this email.` } });
    },
    async sendPasswordReset({ to, url, minutes }) {
      const link = safeActionUrl(url);
      await send({ to, subject: 'Reset your KYCProbe password',
        text: `A password reset was requested for your KYCProbe account.\n\nSet a new password with this link (valid for ${minutes} minutes):\n${link}\n\nIf you did not request this, ignore this email. Your current password remains unchanged.`,
        design: { eyebrow: 'Account security', title: 'Reset your password',
          intro: 'We received a request to reset your KYCProbe password.',
          body: 'Use the button below to choose a new password. Your current password remains unchanged until you complete the reset.',
          action: { label: 'Reset password', url: link },
          note: `This link expires in ${minutes} minutes. If you did not request a reset, you can ignore this email.` } });
    },
    async sendSecurityAlert({ to, event }) {
      const action = event === 'reset' ? 'reset' : 'changed';
      await send({ to, subject: 'Your KYCProbe password was updated',
        text: `Your KYCProbe account password was ${action}. If you did not make this change, reply to notify@ai7lab.net immediately.`,
        design: { eyebrow: 'Security alert', title: 'Your password was updated',
          intro: `The password for your KYCProbe account was ${action}.`,
          body: 'If this was you, no action is needed. If it was not, reply to this email immediately so our team can help secure your account.',
          action: { label: 'Review your account', url: 'https://app.kycprobe.com/account' },
          note: 'KYCProbe will never ask you to disclose your password or API key by email.' } });
    },
    async sendTest({ to }) {
      await send({ to, subject: 'KYCProbe email test',
        text: 'This is a test of KYCProbe platform email. Replies go to notify@ai7lab.net.',
        design: { eyebrow: 'Delivery test', title: 'Email delivery is working',
          intro: 'This is a test message from the KYCProbe platform.', body: 'You can reply to this email at notify@ai7lab.net.',
          note: 'No customer data, password, or API key is included in this test.' } });
    }
  };
}
