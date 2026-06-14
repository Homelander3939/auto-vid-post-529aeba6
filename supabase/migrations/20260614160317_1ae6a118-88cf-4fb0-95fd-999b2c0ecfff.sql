ALTER TABLE public.platform_accounts ADD COLUMN IF NOT EXISTS target_url TEXT;
ALTER TABLE public.social_post_accounts ADD COLUMN IF NOT EXISTS target_url TEXT;