-- Paste this into the Supabase SQL Editor and click Run.
-- This creates the delete_user() function that the app calls when a user deletes their account.
-- It runs with SECURITY DEFINER so it can delete from auth.users (which normal users can't touch).

CREATE OR REPLACE FUNCTION delete_user()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete expenses first (in case there's no cascade)
  DELETE FROM expenses WHERE user_id = auth.uid();
  -- Delete profile
  DELETE FROM profiles WHERE id = auth.uid();
  -- Delete the auth user itself (removes the email/account permanently)
  DELETE FROM auth.users WHERE id = auth.uid();
END;
$$;
