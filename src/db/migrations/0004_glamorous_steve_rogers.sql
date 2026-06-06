ALTER TABLE "project_secrets" ADD COLUMN "vault_enc_key_encrypted" text NOT NULL;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD COLUMN "pg_meta_crypto_key_encrypted" text NOT NULL;