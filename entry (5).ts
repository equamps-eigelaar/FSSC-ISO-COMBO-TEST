import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID');
    const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET');
    const REDIRECT_URI = Deno.env.get('XERO_REDIRECT_URI') || 'https://food-safety-compliance-tracker-6d44af17.base44.app/Billing';

    if (action === 'get_auth_url') {
      const scopes = 'openid profile email accounting.transactions accounting.contacts offline_access';
      const state = crypto.randomUUID();
      const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
      return Response.json({ url, state });
    }

    if (action === 'exchange_code') {
      const { code } = body;
      const credentials = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
      const tokenRes = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) return Response.json({ error: tokenData }, { status: 400 });

      // Get tenant/org info
      const tenantsRes = await fetch('https://api.xero.com/connections', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
      });
      const tenants = await tenantsRes.json();
      const tenantId = tenants[0]?.tenantId;

      // Store tokens in a XeroToken entity (we'll use the service role)
      const existing = await base44.asServiceRole.entities.XeroToken.filter({});
      const tokenRecord = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        tenant_id: tenantId,
        expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
        connected: true,
        org_name: tenants[0]?.tenantName || 'Xero',
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.XeroToken.update(existing[0].id, tokenRecord);
      } else {
        await base44.asServiceRole.entities.XeroToken.create(tokenRecord);
      }

      return Response.json({ success: true, org_name: tokenRecord.org_name });
    }

    if (action === 'get_status') {
      const tokens = await base44.asServiceRole.entities.XeroToken.filter({});
      if (tokens.length === 0) return Response.json({ connected: false });
      const token = tokens[0];
      // Also verify the token isn't expired
      const isExpired = token.expires_at && new Date(token.expires_at) < new Date();
      return Response.json({
        connected: token.connected === true,
        org_name: token.org_name,
        token_expired: isExpired,
      });
    }

    if (action === 'disconnect') {
      const tokens = await base44.asServiceRole.entities.XeroToken.filter({});
      if (tokens.length > 0) {
        await base44.asServiceRole.entities.XeroToken.update(tokens[0].id, { connected: false });
      }
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});