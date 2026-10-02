const bcrypt = require('bcryptjs');
const sendEmail = require('./sendEmail');

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_COOLDOWN_MS = 60 * 1000; // 60 seconds between sends
const OTP_MAX_ATTEMPTS = 5;

const makeOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const otpEmailHtml = (name, otp, purpose) => {
  const title = purpose === 'reset' ? 'Reset your password' : 'Verify your email';
  const line =
    purpose === 'reset'
      ? 'Use this code to reset your Anmool Dairy account password. It expires in 10 minutes.'
      : 'Use this code to verify your Anmool Dairy account email. It expires in 10 minutes.';
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
    <div style="background:#142808;color:#fff;padding:24px;text-align:center">
      <div style="font-size:22px;font-weight:bold">Anmool Dairy</div>
      <div style="font-size:13px;color:#FFC53D;margin-top:4px">Pure Products. Honest Promise.</div>
    </div>
    <div style="padding:28px 24px;text-align:center">
      <h2 style="margin:0 0 8px;color:#142808">Namaste${name ? `, ${name}` : ''} — ${title}</h2>
      <p style="color:#57534e;font-size:14px">${line}</p>
      <div style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#142808;background:#F0F7E6;border:2px dashed #63A822;border-radius:12px;padding:14px 8px 14px 18px;margin:20px 0">${otp}</div>
      <p style="color:#78716c;font-size:12px">Never share this code with anyone. If you did not request it, please ignore this email.</p>
    </div>
  </div>`;
};

/**
 * Issue (and email) a fresh OTP for a user. Enforces 60s resend cooldown.
 * @returns {Promise<{cooldownMs}>} throws with status-coded Error on cooldown
 */
async function issueOtp(user, purpose) {
  const now = new Date();
  if (user.otpLastSent && now - user.otpLastSent < OTP_COOLDOWN_MS) {
    const wait = Math.ceil((OTP_COOLDOWN_MS - (now - user.otpLastSent)) / 1000);
    const err = new Error(`Please wait ${wait}s before requesting a new code`);
    err.status = 429;
    throw err;
  }
  const otp = makeOtp();
  user.otpHash = await bcrypt.hash(otp, 10);
  user.otpExpires = new Date(now.getTime() + OTP_TTL_MS);
  user.otpAttempts = 0;
  user.otpLastSent = now;
  user.otpPurpose = purpose;
  await user.save();

  const result = await sendEmail({
    to: user.email,
    subject: `Anmool Dairy — your verification code ${otp}`,
    html: otpEmailHtml(user.name, otp, purpose),
    text: `Your Anmool Dairy verification code is ${otp}. It expires in 10 minutes.`,
  });
  // No email provider configured yet: log OTP to backend console ONLY for
  // testing. It is never returned to the frontend in any API response.
  if (result && result.simulated) {
    console.log(`OTP for ${user.email} [${purpose}]: ${otp} (valid 10 min — Resend not configured)`);
  }
  return { cooldownMs: OTP_COOLDOWN_MS };
}

/**
 * Verify a submitted OTP. Throws status-coded Error on failure.
 * Clears OTP state on success or on too-many-attempts.
 */
async function verifyOtp(user, otp, purpose) {
  if (!user.otpHash || user.otpPurpose !== purpose || !user.otpExpires) {
    const err = new Error('No active code. Please request a new one.');
    err.status = 400;
    throw err;
  }
  if (new Date() > user.otpExpires) {
    user.otpHash = '';
    user.otpExpires = null;
    user.otpPurpose = '';
    user.otpAttempts = 0;
    await user.save();
    const err = new Error('Code expired. Please request a new one.');
    err.status = 400;
    throw err;
  }
  if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
    user.otpHash = '';
    user.otpExpires = null;
    user.otpPurpose = '';
    user.otpAttempts = 0;
    await user.save();
    const err = new Error('Too many wrong attempts. Please request a new code.');
    err.status = 429;
    throw err;
  }
  const ok = await bcrypt.compare(String(otp || '').trim(), user.otpHash);
  if (!ok) {
    user.otpAttempts += 1;
    await user.save();
    const left = OTP_MAX_ATTEMPTS - user.otpAttempts;
    const err = new Error(left > 0 ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.');
    err.status = 400;
    throw err;
  }
  user.otpHash = '';
  user.otpExpires = null;
  user.otpPurpose = '';
  user.otpAttempts = 0;
  await user.save();
}

module.exports = { issueOtp, verifyOtp, OTP_TTL_MS };
