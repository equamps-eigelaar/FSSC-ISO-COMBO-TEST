import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Admins always have full access
    if (user.role === 'admin') {
      return Response.json({ status: 'approved', is_admin: true });
    }

    const requests = await base44.asServiceRole.entities.UserAccessRequest.filter(
      { email: user.email },
      '-created_date',
      1
    );

    // No record yet — auto-start a 7-day free trial
    if (!requests.length) {
      const trialEndDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      await base44.asServiceRole.entities.UserAccessRequest.create({
        email: user.email,
        full_name: user.full_name || user.email,
        status: 'trial_active',
        trial_end_date: trialEndDate,
      });
      return Response.json({ status: 'trial_active', trial_end_date: trialEndDate });
    }

    const request = requests[0];

    // If trial is active, check if it has expired and downgrade automatically
    if (request.status === 'trial_active' && request.trial_end_date) {
      const expired = new Date(request.trial_end_date) < new Date();
      if (expired) {
        await base44.asServiceRole.entities.UserAccessRequest.update(request.id, { status: 'trial_expired' });
        return Response.json({ status: 'trial_expired', trial_end_date: request.trial_end_date });
      }
    }

    return Response.json({
      status: request.status,
      full_name: request.full_name,
      trial_end_date: request.trial_end_date,
      xero_invoice_number: request.xero_invoice_number,
      xero_invoice_url: request.xero_invoice_url,
      rejection_reason: request.rejection_reason,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});