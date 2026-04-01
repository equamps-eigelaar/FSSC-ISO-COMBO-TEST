import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

async function getValidToken(base44) {
  const tokens = await base44.asServiceRole.entities.XeroToken.filter({});
  if (tokens.length === 0) throw new Error('Xero not connected');
  let token = tokens[0];

  // Refresh if expired
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
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Token refresh failed: ' + JSON.stringify(data));
    token = {
      ...token,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };
    await base44.asServiceRole.entities.XeroToken.update(token.id, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at,
    });
  }
  return token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    const token = await getValidToken(base44);
    const headers = {
      'Authorization': `Bearer ${token.access_token}`,
      'Xero-tenant-id': token.tenant_id,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (action === 'push_invoice') {
      // Push a single billing record to Xero as an invoice
      const { billingRecord } = body;

      const invoiceData = {
        Type: 'ACCREC',
        Contact: { Name: billingRecord.customer_name },
        Date: billingRecord.transaction_date || new Date().toISOString().split('T')[0],
        DueDate: billingRecord.invoice_date || new Date().toISOString().split('T')[0],
        LineItems: [{
          Description: billingRecord.entity_name || billingRecord.description || billingRecord.billable_type,
          Quantity: billingRecord.quantity || 1,
          UnitAmount: billingRecord.unit_cost,
          AccountCode: '200',
        }],
        Status: 'AUTHORISED',
        Reference: billingRecord.invoice_number || '',
        CurrencyCode: billingRecord.currency || 'USD',
      };

      const res = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
        method: 'POST',
        headers,
        body: JSON.stringify({ Invoices: [invoiceData] }),
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });

      const xeroInvoice = data.Invoices?.[0];
      // Update billing record with Xero invoice ID
      if (xeroInvoice && billingRecord.id) {
        await base44.asServiceRole.entities.BillingRecord.update(billingRecord.id, {
          billing_status: 'invoiced',
          invoice_number: xeroInvoice.InvoiceNumber || billingRecord.invoice_number,
          notes: (billingRecord.notes || '') + ` | Xero ID: ${xeroInvoice.InvoiceID}`,
        });
      }
      return Response.json({ success: true, invoice: xeroInvoice });
    }

    if (action === 'push_all_pending') {
      // Push all pending billing records to Xero
      const pending = await base44.asServiceRole.entities.BillingRecord.filter({ billing_status: 'pending' });
      const results = [];
      for (const record of pending) {
        const invoiceData = {
          Type: 'ACCREC',
          Contact: { Name: record.customer_name },
          Date: record.transaction_date || new Date().toISOString().split('T')[0],
          DueDate: record.invoice_date || new Date().toISOString().split('T')[0],
          LineItems: [{
            Description: record.entity_name || record.description || record.billable_type,
            Quantity: record.quantity || 1,
            UnitAmount: record.unit_cost,
            AccountCode: '200',
          }],
          Status: 'AUTHORISED',
          Reference: record.invoice_number || '',
          CurrencyCode: record.currency || 'USD',
        };
        results.push(invoiceData);
      }

      if (results.length === 0) return Response.json({ success: true, pushed: 0 });

      const res = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
        method: 'POST',
        headers,
        body: JSON.stringify({ Invoices: results }),
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });

      // Update each pushed record
      for (let i = 0; i < (data.Invoices?.length || 0); i++) {
        const xeroInv = data.Invoices[i];
        const record = pending[i];
        if (record && xeroInv) {
          await base44.asServiceRole.entities.BillingRecord.update(record.id, {
            billing_status: 'invoiced',
            invoice_number: xeroInv.InvoiceNumber || record.invoice_number,
            notes: (record.notes || '') + ` | Xero ID: ${xeroInv.InvoiceID}`,
          });
        }
      }

      return Response.json({ success: true, pushed: data.Invoices?.length || 0 });
    }

    if (action === 'pull_payments') {
      // Pull paid invoices from Xero and update local billing records
      const res = await fetch('https://api.xero.com/api.xro/2.0/Invoices?Statuses=PAID&page=1', {
        headers,
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });

      const xeroPaidInvoices = data.Invoices || [];
      const invoicedRecords = await base44.asServiceRole.entities.BillingRecord.filter({ billing_status: 'invoiced' });

      let updated = 0;
      const updatedRecords = [];
      for (const inv of xeroPaidInvoices) {
        for (const record of invoicedRecords) {
          const alreadyUpdated = updatedRecords.includes(record.id);
          if (!alreadyUpdated && (
            (record.notes && record.notes.includes(inv.InvoiceID)) ||
            record.invoice_number === inv.InvoiceNumber ||
            (inv.Reference && record.invoice_number && inv.Reference === record.invoice_number)
          )) {
            await base44.asServiceRole.entities.BillingRecord.update(record.id, {
              billing_status: 'paid',
              notes: (record.notes || '') + ` | Auto-marked paid from Xero on ${new Date().toISOString().split('T')[0]}`,
            });
            updatedRecords.push(record.id);
            updated++;
          }
        }
      }
      return Response.json({ success: true, updated, total_xero_paid: xeroPaidInvoices.length });
    }

    if (action === 'ai_reconcile') {
      // Fetch paid invoices from Xero
      const xeroRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices?Statuses=PAID,AUTHORISED&page=1', { headers });
      const xeroData = await xeroRes.json();
      if (!xeroRes.ok) return Response.json({ error: xeroData }, { status: 400 });

      const xeroInvoices = (xeroData.Invoices || []).map(inv => ({
        xero_id: inv.InvoiceID,
        invoice_number: inv.InvoiceNumber,
        contact_name: inv.Contact?.Name || '',
        total: inv.Total,
        amount_due: inv.AmountDue,
        status: inv.Status,
        date: inv.Date ? inv.Date.replace('/Date(', '').replace(')/', '') : null,
      })).map(inv => ({
        ...inv,
        // Convert Xero epoch ms date to ISO date string
        date_iso: inv.date ? new Date(parseInt(inv.date)).toISOString().split('T')[0] : null,
      }));

      // Fetch all pending and invoiced billing records
      const localRecords = await base44.asServiceRole.entities.BillingRecord.filter({});
      const openRecords = localRecords.filter(r => r.billing_status === 'pending' || r.billing_status === 'invoiced');

      if (xeroInvoices.length === 0 || openRecords.length === 0) {
        return Response.json({ success: true, matched: [], flagged: [], auto_updated: 0 });
      }

      // Ask AI to match
      const prompt = `You are a financial reconciliation AI. Match the following Xero invoices to the local billing records.

XERO INVOICES (paid or authorised):
${JSON.stringify(xeroInvoices, null, 2)}

LOCAL BILLING RECORDS (pending or invoiced):
${JSON.stringify(openRecords.map(r => ({
  id: r.id,
  invoice_number: r.invoice_number,
  customer_name: r.customer_name,
  total_cost: r.total_cost,
  transaction_date: r.transaction_date,
  billing_status: r.billing_status,
  notes: r.notes,
})), null, 2)}

Rules:
1. Match based on: invoice_number (strongest), then customer name similarity + amount match, then xero_id in notes.
2. For PAID Xero invoices matched to local records, mark as confirmed_paid.
3. For AUTHORISED (not yet paid) Xero invoices matched to local records, mark as confirmed_invoiced.
4. If a Xero invoice cannot be matched to any local record, flag it for manual review.
5. If a local record has discrepancies (amount mismatch > 1%, name mismatch), flag it with the reason.

Return ONLY a valid JSON object with:
- matched: array of {xero_invoice_number, xero_id, local_record_id, local_customer_name, amount, action: "mark_paid"|"mark_invoiced", confidence: "high"|"medium"|"low"}
- flagged: array of {xero_invoice_number, xero_id, contact_name, amount, reason: string}`;

      const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: 'object',
          properties: {
            matched: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  xero_invoice_number: { type: 'string' },
                  xero_id: { type: 'string' },
                  local_record_id: { type: 'string' },
                  local_customer_name: { type: 'string' },
                  amount: { type: 'number' },
                  action: { type: 'string' },
                  confidence: { type: 'string' },
                },
              },
            },
            flagged: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  xero_invoice_number: { type: 'string' },
                  xero_id: { type: 'string' },
                  contact_name: { type: 'string' },
                  amount: { type: 'number' },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
      });

      // Auto-apply high-confidence matches
      let auto_updated = 0;
      for (const match of (aiResult.matched || [])) {
        if (match.confidence === 'high' && match.local_record_id) {
          const newStatus = match.action === 'mark_paid' ? 'paid' : 'invoiced';
          await base44.asServiceRole.entities.BillingRecord.update(match.local_record_id, {
            billing_status: newStatus,
            notes: `AI reconciled | Xero ID: ${match.xero_id}`,
          });
          auto_updated++;
        }
      }

      return Response.json({
        success: true,
        matched: aiResult.matched || [],
        flagged: aiResult.flagged || [],
        auto_updated,
      });
    }

    if (action === 'get_chart_of_accounts') {
      // Fetch chart of accounts from Xero
      const res = await fetch('https://api.xero.com/api.xro/2.0/Accounts?where=Status=="ACTIVE"AND(Class=="REVENUE"OR Class=="EXPENSE")', {
        headers,
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });
      const accounts = (data.Accounts || []).map(a => ({
        code: a.Code,
        name: a.Name,
        type: a.Type,
        class: a.Class,
        description: a.Description || '',
      }));
      return Response.json({ success: true, accounts });
    }

    if (action === 'get_paid_invoices') {
      // Fetch PAID invoices from Xero with full detail for manual reconciliation
      const page = body.page || 1;
      const search = body.search || '';
      let url = `https://api.xero.com/api.xro/2.0/Invoices?Statuses=PAID,AUTHORISED&page=${page}&order=UpdatedDateUTC DESC`;
      if (search) url += `&ContactName=${encodeURIComponent(search)}`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });
      const invoices = (data.Invoices || []).map(inv => ({
        xero_id: inv.InvoiceID,
        invoice_number: inv.InvoiceNumber,
        contact_name: inv.Contact?.Name || '',
        total: inv.Total,
        amount_due: inv.AmountDue,
        amount_paid: inv.AmountPaid,
        status: inv.Status,
        date_iso: inv.Date ? new Date(parseInt(inv.Date.replace('/Date(', '').replace(')/', ''))).toISOString().split('T')[0] : null,
        currency: inv.CurrencyCode,
        reference: inv.Reference || '',
      }));
      return Response.json({ success: true, invoices });
    }

    if (action === 'manual_reconcile') {
      // Manually link a Xero invoice to a local billing record and mark as paid
      const { localRecordId, xeroInvoiceId, xeroInvoiceNumber } = body;
      if (!localRecordId) return Response.json({ error: 'localRecordId required' }, { status: 400 });
      const record = await base44.asServiceRole.entities.BillingRecord.filter({ id: localRecordId });
      if (!record.length) return Response.json({ error: 'Billing record not found' }, { status: 404 });
      await base44.asServiceRole.entities.BillingRecord.update(localRecordId, {
        billing_status: 'paid',
        notes: ((record[0].notes || '') + ` | Manually reconciled | Xero ID: ${xeroInvoiceId} | Xero Ref: ${xeroInvoiceNumber}`).trim(),
      });
      return Response.json({ success: true });
    }

    if (action === 'authorise_invoice') {
      // Approve a DRAFT invoice → update to AUTHORISED in Xero
      const { xeroInvoiceId, localRecordId } = body;
      if (!xeroInvoiceId) return Response.json({ error: 'xeroInvoiceId required' }, { status: 400 });

      const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ Status: 'AUTHORISED' }),
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });

      if (localRecordId) {
        await base44.asServiceRole.entities.BillingRecord.update(localRecordId, {
          billing_status: 'invoiced',
          xero_approval_status: 'approved',
        });
      }
      return Response.json({ success: true, invoice: data.Invoices?.[0] });
    }

    if (action === 'reject_invoice') {
      // Reject a DRAFT invoice → void it in Xero and record reason locally
      const { xeroInvoiceId, localRecordId, rejectionReason } = body;
      if (!xeroInvoiceId) return Response.json({ error: 'xeroInvoiceId required' }, { status: 400 });

      const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ Status: 'VOIDED' }),
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });

      if (localRecordId) {
        await base44.asServiceRole.entities.BillingRecord.update(localRecordId, {
          xero_approval_status: 'rejected',
          xero_rejection_reason: rejectionReason || '',
          billing_status: 'pending',
          notes: `Invoice rejected: ${rejectionReason || 'No reason given'}`,
        });
      }
      return Response.json({ success: true });
    }

    if (action === 'suggest_account_code') {
      // Use AI to suggest optimal Xero account codes for a line item
      const { billingRecord } = body;
      const prompt = `You are an expert accountant familiar with Xero chart of accounts.
Given the following billing line item, suggest the most appropriate Xero account code and account name.
Return ONLY a JSON object with these fields: account_code (string), account_name (string), reasoning (string, 1-2 sentences).

Line item details:
- Type: ${billingRecord.billable_type}
- Description: ${billingRecord.entity_name || billingRecord.description || ''}
- Customer type: ${billingRecord.customer_type}
- Amount: ${billingRecord.total_cost} ${billingRecord.currency || 'USD'}

Common Xero account codes:
- 200: Sales
- 260: Other Revenue
- 270: Interest Income
- 310: Cost of Goods Sold
- 400: Advertising
- 404: Entertainment
- 408: IT Software & Subscriptions
- 412: Professional Services
- 420: Rent
- 441: Consulting & Legal
- 461: Research & Development

Respond with ONLY a valid JSON object.`;

      const llmRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: 'object',
          properties: {
            account_code: { type: 'string' },
            account_name: { type: 'string' },
            reasoning: { type: 'string' },
          },
        },
      });

      return Response.json({ success: true, suggestion: llmRes });
    }

    if (action === 'create_draft_invoice') {
      // Create a DRAFT invoice in Xero (not yet authorised) with AI-suggested or user-provided account code
      const { billingRecord, accountCode, dueDate } = body;

      const invoiceData = {
        Type: 'ACCREC',
        Contact: { Name: billingRecord.customer_name },
        Date: billingRecord.transaction_date || new Date().toISOString().split('T')[0],
        DueDate: dueDate || billingRecord.invoice_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        LineItems: [{
          Description: [billingRecord.entity_name, billingRecord.description].filter(Boolean).join(' — ') || billingRecord.billable_type,
          Quantity: billingRecord.quantity || 1,
          UnitAmount: billingRecord.unit_cost,
          AccountCode: accountCode || '200',
        }],
        Status: 'DRAFT',
        Reference: billingRecord.invoice_number || '',
        CurrencyCode: billingRecord.currency || 'USD',
      };

      const res = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
        method: 'POST',
        headers,
        body: JSON.stringify({ Invoices: [invoiceData] }),
      });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data }, { status: 400 });

      const xeroInvoice = data.Invoices?.[0];
      if (xeroInvoice && billingRecord.id) {
        await base44.asServiceRole.entities.BillingRecord.update(billingRecord.id, {
          billing_status: 'invoiced',
          invoice_number: xeroInvoice.InvoiceNumber || billingRecord.invoice_number,
          notes: (billingRecord.notes || '') + ` | Xero Draft ID: ${xeroInvoice.InvoiceID}`,
        });
      }
      return Response.json({ success: true, invoice: xeroInvoice });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});