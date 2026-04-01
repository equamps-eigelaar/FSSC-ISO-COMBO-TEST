import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

async function getValidXeroToken(base44) {
  const tokens = await base44.asServiceRole.entities.XeroToken.filter({});
  if (tokens.length === 0) throw new Error('Xero not connected');
  let token = tokens[0];
  if (new Date(token.expires_at) < new Date(Date.now() + 60000)) {
    const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID');
    const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET');
    const credentials = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
    const res = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Token refresh failed: ' + JSON.stringify(data));
    token = { ...token, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString() };
    await base44.asServiceRole.entities.XeroToken.update(token.id, {
      access_token: token.access_token, refresh_token: token.refresh_token, expires_at: token.expires_at,
    });
  }
  return token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const admin = await base44.auth.me();
    if (admin?.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { request_id, approval_notes, plan_id, plan_name, plan_amount, billing_cycle } = await req.json();
    if (!request_id) return Response.json({ error: 'Request ID required' }, { status: 400 });

    const accessRequests = await base44.asServiceRole.entities.UserAccessRequest.filter({ id: request_id }, null, 1);
    if (!accessRequests.length) return Response.json({ error: 'Request not found' }, { status: 404 });
    const reqData = accessRequests[0];

    // --- Create Xero invoice ---
    let xeroInvoiceId = null;
    let xeroInvoiceNumber = null;
    let xeroInvoiceUrl = null;

    if (plan_amount && plan_amount > 0) {
      const token = await getValidXeroToken(base44);
      const xeroHeaders = {
        'Authorization': `Bearer ${token.access_token}`,
        'Xero-tenant-id': token.tenant_id,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
      const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      const invoiceData = {
        Type: 'ACCREC',
        Contact: { Name: reqData.company || reqData.full_name },
        Date: new Date().toISOString().split('T')[0],
        DueDate: dueDate,
        LineItems: [{
          Description: `FSMS Compliance Tracker — ${plan_name || 'Subscription'} (${billing_cycle || 'monthly'})`,
          Quantity: 1,
          UnitAmount: plan_amount,
          AccountCode: '200',
        }],
        Status: 'AUTHORISED',
        Reference: `ACCESS-${reqData.email}`,
        CurrencyCode: 'ZAR',
      };
      const xeroRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
        method: 'POST',
        headers: xeroHeaders,
        body: JSON.stringify({ Invoices: [invoiceData] }),
      });
      const xeroData = await xeroRes.json();
      if (xeroRes.ok && xeroData.Invoices?.[0]) {
        xeroInvoiceId = xeroData.Invoices[0].InvoiceID;
        xeroInvoiceNumber = xeroData.Invoices[0].InvoiceNumber;
        // Try to get online invoice URL
        try {
          const urlRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}/OnlineInvoice`, { headers: xeroHeaders });
          const urlData = await urlRes.json();
          xeroInvoiceUrl = urlData.OnlineInvoices?.[0]?.OnlineInvoiceUrl || null;
        } catch (_) { /* optional */ }
      }
    }

    // Update request status
    const newStatus = xeroInvoiceId ? 'payment_pending' : 'trial_active';
    await base44.asServiceRole.entities.UserAccessRequest.update(request_id, {
      status: newStatus,
      approved_by: admin.email,
      approved_date: new Date().toISOString(),
      approval_notes: approval_notes || '',
      plan_id: plan_id || null,
      plan_name: plan_name || null,
      plan_amount: plan_amount || null,
      billing_cycle: billing_cycle || 'monthly',
      xero_invoice_id: xeroInvoiceId,
      xero_invoice_number: xeroInvoiceNumber,
      xero_invoice_url: xeroInvoiceUrl,
    });

    // Send email to user
    const invoiceSection = xeroInvoiceId
      ? `\n\nTo activate your account, please pay the invoice sent to you:\n- Plan: ${plan_name}\n- Amount: R${plan_amount?.toLocaleString()} ZAR (${billing_cycle})\n- Invoice: ${xeroInvoiceNumber}${xeroInvoiceUrl ? `\n- Pay online: ${xeroInvoiceUrl}` : ''}\n\nYour account will be activated automatically once payment is confirmed.`
      : `\n\nYou now have a 7-day free trial. Use the link below to activate:\n${req.headers.get('origin') || 'https://food-safety-compliance-tracker-6d44af17.base44.app'}`;

    await base44.integrations.Core.SendEmail({
      to: reqData.email,
      subject: xeroInvoiceId ? `Invoice Ready — Activate Your FSMS Compliance Tracker Access` : 'Your Access Has Been Approved! 🎉',
      body: `Hi ${reqData.full_name},\n\nGreat news — your access request for FSMS Compliance Tracker has been reviewed and approved!${invoiceSection}\n\nQuestions? Reply to this email.\n\nThank you,\nFSMS Compliance Tracker Team`,
    });

    return Response.json({ success: true, status: newStatus, xero_invoice_id: xeroInvoiceId, xero_invoice_number: xeroInvoiceNumber });
  } catch (error) {
    console.error('Approval error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});