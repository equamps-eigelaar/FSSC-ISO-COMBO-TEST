import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

async function getValidToken(base44) {
  const tokens = await base44.asServiceRole.entities.XeroToken.filter({});
  if (tokens.length === 0) throw new Error('Xero not connected');
  let token = tokens[0];

  if (new Date(token.expires_at) < new Date(Date.now() + 60000)) {
    const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID');
    const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET');
    const credentials = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
    const res = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Token refresh failed: ' + JSON.stringify(data));
    token = { ...token, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString() };
    await base44.asServiceRole.entities.XeroToken.update(token.id, { access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at });
  }
  return token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { customerName, customerEmail, planId, billingCycle = 'monthly', accountCode } = body;

    if (!customerName) return Response.json({ error: 'customerName is required' }, { status: 400 });
    if (!planId) return Response.json({ error: 'planId is required' }, { status: 400 });

    // Load plan
    const plans = await base44.asServiceRole.entities.PricePlan.filter({ id: planId });
    if (!plans.length) return Response.json({ error: 'Plan not found' }, { status: 404 });
    const plan = plans[0];

    const unitAmount = billingCycle === 'annual'
      ? (plan.price_annual || Math.round(plan.price_monthly * 0.85))
      : plan.price_monthly;

    const today = new Date().toISOString().split('T')[0];
    const dueDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

    // Create AUTHORISED invoice in Xero (awaiting payment)
    const token = await getValidToken(base44);
    const headers = {
      'Authorization': `Bearer ${token.access_token}`,
      'Xero-tenant-id': token.tenant_id,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const invoicePayload = {
      Type: 'ACCREC',
      Contact: { Name: customerName, EmailAddress: customerEmail || '' },
      Date: today,
      DueDate: dueDate,
      Status: 'AUTHORISED', // Awaiting payment — not DRAFT
      Reference: `SUB-${plan.tier?.toUpperCase()}-${Date.now()}`,
      CurrencyCode: plan.currency || 'ZAR',
      LineItems: [{
        Description: `${plan.name} Plan — ${billingCycle === 'annual' ? 'Annual' : 'Monthly'} Subscription`,
        Quantity: 1,
        UnitAmount: unitAmount,
        AccountCode: accountCode || plan.xero_account_code || '200',
      }],
    };

    const xeroRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST',
      headers,
      body: JSON.stringify({ Invoices: [invoicePayload] }),
    });
    const xeroData = await xeroRes.json();
    if (!xeroRes.ok) throw new Error('Xero invoice creation failed: ' + JSON.stringify(xeroData));

    const xeroInvoice = xeroData.Invoices?.[0];
    const xeroInvoiceId = xeroInvoice?.InvoiceID;
    const xeroInvoiceNumber = xeroInvoice?.InvoiceNumber;

    // Get online invoice URL if available
    let xeroInvoiceUrl = null;
    try {
      const onlineRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}/OnlineInvoice`, { headers });
      const onlineData = await onlineRes.json();
      xeroInvoiceUrl = onlineData.OnlineInvoices?.[0]?.OnlineInvoiceUrl || null;
    } catch (_) {}

    // Create a BillingRecord for tracking
    await base44.asServiceRole.entities.BillingRecord.create({
      transaction_date: today,
      billable_type: 'subscription',
      entity_name: `${plan.name} Plan Subscription`,
      customer_type: 'external',
      customer_name: customerName,
      customer_email: customerEmail || '',
      quantity: 1,
      unit_cost: unitAmount,
      total_cost: unitAmount,
      currency: plan.currency || 'ZAR',
      description: `${billingCycle === 'annual' ? 'Annual' : 'Monthly'} subscription — ${plan.name}`,
      billing_status: 'invoiced',
      xero_invoice_id: xeroInvoiceId,
      xero_approval_status: 'authorised',
      invoice_number: xeroInvoiceNumber,
      notes: `Pushed to Xero as AUTHORISED invoice. Awaiting payment. Plan: ${plan.name}`,
    });

    // If customer email provided, find their UserAccessRequest and set to payment_pending
    if (customerEmail) {
      const accessRequests = await base44.asServiceRole.entities.UserAccessRequest.filter({ email: customerEmail });
      if (accessRequests.length > 0) {
        await base44.asServiceRole.entities.UserAccessRequest.update(accessRequests[0].id, {
          status: 'payment_pending',
          xero_invoice_number: xeroInvoiceNumber,
          xero_invoice_url: xeroInvoiceUrl,
        });
      } else {
        // Create a new access request in payment_pending state for this email
        await base44.asServiceRole.entities.UserAccessRequest.create({
          email: customerEmail,
          full_name: customerName,
          status: 'payment_pending',
          xero_invoice_number: xeroInvoiceNumber,
          xero_invoice_url: xeroInvoiceUrl,
        });
      }
    }

    return Response.json({
      success: true,
      message: `Invoice ${xeroInvoiceNumber} created in Xero and is awaiting payment. Access will be granted once payment is confirmed.`,
      xeroInvoice: { id: xeroInvoiceId, number: xeroInvoiceNumber, url: xeroInvoiceUrl },
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});