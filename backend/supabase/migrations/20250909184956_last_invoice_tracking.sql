ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS last_processed_invoice_id VARCHAR(255);