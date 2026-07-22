-- Remove the superseded Turnstile-management RPC and keep only the grants
-- required by the browser application's anonymous, token-authenticated gateway.

drop function if exists public.msob_owner_security_gateway(text, text, jsonb);

revoke execute on function public.msob_owner_gateway(text, text, jsonb)
  from authenticated;
revoke execute on function public.msob_public_runtime_config()
  from authenticated;
