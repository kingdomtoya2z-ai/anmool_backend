const { Resend } = require('resend');

let resend = null;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

/**
 * Send email via Resend
 * Replies go to RESEND_REPLY_TO (default: anmooldairy07@gmail.com) so customer
 * replies land in the store inbox. Note: Resend only allows FROM addresses on
 * verified domains — a gmail address can NEVER be the sender, only reply-to.
 * @param {Object} opts - { to, subject, html, text, from, replyTo }
 */
const sendEmail = async ({ to, subject, html, text, from, replyTo }) => {
  const fallbackLog = () => {
    console.log('==== EMAIL (SIMULATED - Resend not configured) ====');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${text || html?.slice(0, 500)}`);
    console.log('Set RESEND_API_KEY in .env to send real emails via Resend');
    console.log('====================================================');
    return { simulated: true, to, subject };
  };

  const key = process.env.RESEND_API_KEY || '';
  if (!resend || !key || key === 'dummy' || key.includes('dummy') || key.includes('your_') || key.includes('placeholder') || key.length < 20) {
    return fallbackLog();
  }

  const emailFrom = from || process.env.RESEND_FROM || process.env.EMAIL_FROM || 'Anmool Dairy <onboarding@resend.dev>';
  // Resend requires verified domain for FROM; onboarding@resend.dev works for testing to verified email
  const emailReplyTo = replyTo || process.env.RESEND_REPLY_TO || 'anmooldairy07@gmail.com';

  try {
    const { data, error } = await resend.emails.send({
      from: emailFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: html || `<p>${text || ''}</p>`,
      text: text || undefined,
      reply_to: emailReplyTo,
    });

    if (error) {
      console.error('Resend error:', error);
      console.log('==== EMAIL FALLBACK LOG ====');
      console.log(`To: ${to} | Subject: ${subject} | Error: ${JSON.stringify(error)}`);
      // Don't throw - return fallback so order flow doesn't fail
      return { error: error.message || JSON.stringify(error), simulated: true, fallback: true };
    }

    console.log(`✉️  Email sent via Resend → ${to} | ID: ${data?.id} | Subject: ${subject}`);
    return data;
  } catch (err) {
    console.error('Resend exception:', err.message);
    console.log('==== EMAIL FALLBACK LOG ====');
    console.log(`To: ${to} | Subject: ${subject}`);
    return { error: err.message, simulated: true, fallback: true };
  }
};

module.exports = sendEmail;
