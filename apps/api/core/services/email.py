import os
import logging
from typing import Optional
import mailtrap as mt
from core.utils.config import config

logger = logging.getLogger(__name__)

class EmailService:
    def __init__(self):
        self.api_token = os.getenv('MAILTRAP_API_TOKEN')
        self.sender_email = os.getenv('MAILTRAP_SENDER_EMAIL', 'hey@kortix.com')
        self.sender_name = os.getenv('MAILTRAP_SENDER_NAME', 'Kortix Team')
        self.hello_email = 'hello@kortix.com'
        
        if not self.api_token:
            logger.warning("MAILTRAP_API_TOKEN not found in environment variables")
            self.client = None
        else:
            self.client = mt.MailtrapClient(token=self.api_token)
    
    def send_welcome_email(self, user_email: str, user_name: Optional[str] = None) -> bool:
        if not self.client:
            logger.error("Cannot send email: MAILTRAP_API_TOKEN not configured")
            return False
    
        if not user_name:
            user_name = user_email.split('@')[0].title()
        
        subject = "🎉 Welcome to Kortix — Let's Get Started "
        html_content = self._get_welcome_email_template(user_name)
        text_content = self._get_welcome_email_text(user_name)
        
        return self._send_email(
            to_email=user_email,
            to_name=user_name,
            subject=subject,
            html_content=html_content,
            text_content=text_content
        )
    
    def send_referral_email(
        self, 
        recipient_email: str, 
        recipient_name: str,
        sender_name: str, 
        referral_url: str
    ) -> bool:
        if not self.client:
            logger.error("Cannot send email: MAILTRAP_API_TOKEN not configured")
            return False
        
        subject = f"🎉 You're invited!"
        html_content = self._get_referral_email_template(recipient_name, sender_name, referral_url)
        text_content = self._get_referral_email_text(recipient_name, sender_name, referral_url)
        
        try:
            sender_email_to_use = self.hello_email
            
            logger.info(f"Attempting to send referral email from {sender_email_to_use} to {recipient_email}")
            
            mail = mt.Mail(
                sender=mt.Address(email=sender_email_to_use, name='Kortix'),
                to=[mt.Address(email=recipient_email, name=recipient_name)],
                subject=subject,
                text=text_content,
                html=html_content,
                category="referral"
            )
            
            response = self.client.send(mail)
            
            logger.info(f"Referral email sent to {recipient_email} from {sender_name}. Response: {response}")
            return True
                
        except Exception as e:
            error_type = type(e).__name__
            error_details = str(e)
            logger.error(f"Error sending referral email to {recipient_email}: {error_details}")
            logger.error(f"Error type: {error_type}")
            logger.error(f"Mailtrap API Token present: {bool(self.api_token)}, Token prefix: {self.api_token[:8] if self.api_token else 'None'}...")
            logger.error(f"Sender email: {sender_email_to_use}")
            
            if hasattr(e, 'response'):
                logger.error(f"Response status: {e.response.status_code if hasattr(e.response, 'status_code') else 'unknown'}")
                logger.error(f"Response body: {e.response.text if hasattr(e.response, 'text') else 'unknown'}")
            
            return False
    
    def _send_email(
        self, 
        to_email: str, 
        to_name: str, 
        subject: str, 
        html_content: str, 
        text_content: str
    ) -> bool:
        try:
            mail = mt.Mail(
                sender=mt.Address(email=self.sender_email, name=self.sender_name),
                to=[mt.Address(email=to_email, name=to_name)],
                subject=subject,
                text=text_content,
                html=html_content,
                category="welcome"
            )
            
            response = self.client.send(mail)
            
            logger.debug(f"Welcome email sent to {to_email}. Response: {response}")
            return True
                
        except Exception as e:
            logger.error(f"Error sending email to {to_email}: {str(e)}")
            return False
    
    def _get_welcome_email_template(self, user_name: str) -> str:
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Kortix</title>
  <style>
    body {{
      font-family: Arial, sans-serif;
      background-color: #ffffff;
      color: #000000;
      margin: 0;
      padding: 0;
      line-height: 1.6;
    }}
    .container {{
      max-width: 600px;
      margin: 40px auto;
      padding: 30px;
      background-color: #ffffff;
    }}
    .logo-container {{
      text-align: center;
      margin-bottom: 30px;
      padding: 10px 0;
    }}
    .logo {{
      max-width: 100%;
      height: auto;
      max-height: 60px;
      display: inline-block;
    }}
    h1 {{
      font-size: 24px;
      color: #000000;
      margin-bottom: 20px;
    }}
    p {{
      margin-bottom: 16px;
    }}
    a {{
      color: #3366cc;
      text-decoration: none;
    }}
    a:hover {{
      text-decoration: underline;
    }}
    .button {{
      display: inline-block;
      margin-top: 30px;
      background-color: #3B82F6;
      color: white !important;
      padding: 14px 24px;
      text-align: center;
      text-decoration: none;
      font-weight: bold;
      border-radius: 6px;
      border: none;
    }}
    .button:hover {{
      background-color: #2563EB;
      text-decoration: none;
    }}
    .emoji {{
      font-size: 20px;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="logo-container">
      <img src="https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/loaded_images/Profile%20Picture%20Black.png" alt="Kortix Logo" class="logo">
    </div>

    <p>Hi {user_name},</p>

    <p><em><strong>Welcome to <a href="https://www.kortix.com/">Kortix.com</a> — we're excited to have you on board!</strong></em></p>

    <p>To get started, we'd like to get to know you better: fill out this short <a href="https://docs.google.com/forms/d/e/1FAIpQLSef1EHuqmIh_iQz-kwhjnzSC3Ml-V_5wIySDpMoMU9W_j24JQ/viewform">form</a>!</p>

    <p>To celebrate your arrival, here's a <strong>15% discount</strong> for your first month:</p>
    <p>🎁 Use code <strong>WELCOME15</strong> at checkout.</p>

    <p>Let us know if you need help getting started or have questions — we're always here, and join our <a href="https://discord.com/invite/RvFhXUdZ9H">Discord community</a>.</p>

    <p>Thanks again, and welcome to the Kortix community!</p>
  </div>
</body>
</html>"""
    
    def _get_welcome_email_text(self, user_name: str) -> str:
        return f"""Hi {user_name},

Welcome to https://www.kortix.com/ — we're excited to have you on board!

To get started, we'd like to get to know you better: fill out this short form!
https://docs.google.com/forms/d/e/1FAIpQLSef1EHuqmIh_iQz-kwhjnzSC3Ml-V_5wIySDpMoMU9W_j24JQ/viewform

To celebrate your arrival, here's a 15% discount for your first month:
🎁 Use code WELCOME15 at checkout.

Let us know if you need help getting started or have questions — we're always here, and join our Discord community: https://discord.com/invite/RvFhXUdZ9H

Thanks again, and welcome to the Kortix community!

---
© 2025 Kortix. All rights reserved.
You received this email because you signed up for a Kortix account."""
    
    def _get_referral_email_template(self, recipient_name: str, sender_name: str, referral_url: str) -> str:
        content = f"""<table cellpadding="0" cellspacing="0" border="0" style="padding:30px 15px; font-family:Inter, Arial, sans-serif; color:#000000;">
  <tr>
    <td>
      <p style="margin:0 0 16px 0; font-size:15px; line-height:1.6;">
        Hi <strong>{recipient_name}</strong>,  👋
      </p>
      <p style="margin:0 0 20px 0; font-size:15px; line-height:1.6;">
        <strong>{sender_name}</strong> has invited you to join Kortix using a personal referral code.
        When you sign up using this link, both you and {sender_name} will receive 100 in non-expiring credits 🎁
      </p>
      <p style="margin:0 0 10px 0; font-weight:600;">
        What You Both Get
      </p>
      <table cellpadding="0" cellspacing="0" border="0" style="background:#fafafa; border:1px solid #e5e7eb; border-radius:16px; padding:16px; margin:0 0 20px 0;">
        <tr>
          <td style="font-size:14px; line-height:1.6;">
            <ul style="margin:0; padding-left:18px;">
              <li>100 non-expiring credits to be used in the platform</li>
            </ul>
          </td>
        </tr>
      </table>
      <br/>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px auto;">
        <tr>
          <td>
            <a href="{referral_url}" style="background:#000000; color:#ffffff; padding:12px 24px; text-decoration:none; font-size:15px; font-weight:500; border-radius:16px; display:inline-block;">
              Claim Your Invite
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>"""
        
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kortix</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <div style="text-align: center; margin-bottom: 40px;">
          <img src="https://kortix.com/Logomark.svg" alt="Kortix" style="height: 24px; width: auto; display: inline-block;" />
        </div>
        <div style="background-color: #ffffff; border-radius: 16px; padding: 40px 32px;">
          {content}
        </div>
        <div style="text-align: center; margin-top: 32px;">
          <p style="font-size: 12px; color: #999; margin: 0;">
            &copy; Kortix AI Corp. All rights reserved.
          </p>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>"""
    
    def _get_referral_email_text(self, recipient_name: str, sender_name: str, referral_url: str) -> str:
        return f"""Hi {recipient_name},

{sender_name} has invited you to join Kortix using a personal referral code.

When you sign up using this link, both you and {sender_name} will receive 100 in non-expiring credits 🎁

What You Both Get:
• 100 non-expiring credits to be used in the platform

Claim your invite: {referral_url}

---
© Kortix AI Corp. All rights reserved."""

    def send_otp_email(self, user_email: str, otp_code: str) -> bool:
        """Send an OTP-only email (no magic link button) for users with expired links."""
        if not self.client:
            logger.error("Cannot send email: MAILTRAP_API_TOKEN not configured")
            return False

        subject = "Your Kortix verification code"
        html_content = self._get_otp_email_template(otp_code)
        text_content = self._get_otp_email_text(otp_code)

        try:
            mail = mt.Mail(
                sender=mt.Address(email=self.sender_email, name=self.sender_name),
                to=[mt.Address(email=user_email, name=user_email.split('@')[0].title())],
                subject=subject,
                text=text_content,
                html=html_content,
                category="otp"
            )

            response = self.client.send(mail)
            logger.info(f"OTP email sent to {user_email}. Response: {response}")
            return True

        except Exception as e:
            logger.error(f"Error sending OTP email to {user_email}: {str(e)}")
            return False

    def _get_otp_email_template(self, otp_code: str) -> str:
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your verification code</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <div style="text-align: center; margin-bottom: 40px;">
          <img src="https://kortix.com/Logomark.svg" alt="Kortix" style="height: 24px; width: auto; display: inline-block;" />
        </div>
        <div style="background-color: #ffffff; border-radius: 16px; padding: 40px 32px; text-align: center;">
          <h1 style="font-size: 24px; font-weight: 500; color: #000; margin: 0 0 16px 0; letter-spacing: -0.02em;">
            Your verification code
          </h1>
          <p style="font-size: 15px; line-height: 22px; color: #666; margin: 0 0 32px 0;">
            Enter this code to sign in to your account:
          </p>
          <div style="background-color: #f5f5f5; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
            <p style="font-size: 36px; font-weight: 600; letter-spacing: 8px; color: #000; margin: 0; font-family: 'Courier New', monospace;">
              {otp_code}
            </p>
          </div>
          <p style="font-size: 13px; line-height: 18px; color: #999; margin: 0;">
            This code expires in 1 hour. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
        <div style="text-align: center; margin-top: 32px;">
          <p style="font-size: 12px; color: #999; margin: 0;">
            &copy; Kortix AI Corp. All rights reserved.
          </p>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>"""

    def _get_otp_email_text(self, otp_code: str) -> str:
        return f"""Your Kortix verification code

Enter this code to sign in to your account:

{otp_code}

This code expires in 1 hour. If you didn't request this, you can safely ignore this email.

---
© Kortix AI Corp. All rights reserved."""


email_service = EmailService() 
