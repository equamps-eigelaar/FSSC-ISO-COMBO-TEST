import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { action, templateName, submitterEmail, rejectionReason } = await req.json();

    if (action === 'submitted') {
      // Notify all admins
      const admins = await base44.asServiceRole.entities.User.filter({ role: 'admin' });
      for (const admin of admins) {
        await base44.integrations.Core.SendEmail({
          to: admin.email,
          from_name: 'CTP Flexibles Compliance',
          subject: `📋 Document Approval Required: ${templateName}`,
          body: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:#059669;padding:20px;border-radius:8px 8px 0 0;">
                <h2 style="color:white;margin:0;">Document Approval Required</h2>
              </div>
              <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
                <p style="color:#374151;margin-top:0;">A document template has been submitted and requires your approval before it can be published.</p>
                <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                  <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Document</td><td style="padding:8px 0;font-weight:600;color:#111827;">${templateName}</td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Submitted by</td><td style="padding:8px 0;color:#111827;">${submitterEmail}</td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Date</td><td style="padding:8px 0;color:#111827;">${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}</td></tr>
                </table>
                <p style="color:#6b7280;font-size:13px;">Please log in to the Compliance Tracker → Document Templates → Approvals tab to review and action this request.</p>
              </div>
            </div>
          `
        });
      }
    } else if (action === 'approved') {
      await base44.integrations.Core.SendEmail({
        to: submitterEmail,
        from_name: 'CTP Flexibles Compliance',
        subject: `✅ Document Approved: ${templateName}`,
        body: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#059669;padding:20px;border-radius:8px 8px 0 0;">
              <h2 style="color:white;margin:0;">Document Template Approved</h2>
            </div>
            <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
              <p style="color:#374151;margin-top:0;">Your document template has been <strong>approved</strong> and is now published and available to all users.</p>
              <table style="width:100%;border-collapse:collapse;">
                <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Document</td><td style="padding:8px 0;font-weight:600;color:#111827;">${templateName}</td></tr>
                <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Approved on</td><td style="padding:8px 0;color:#111827;">${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}</td></tr>
              </table>
            </div>
          </div>
        `
      });
    } else if (action === 'rejected') {
      await base44.integrations.Core.SendEmail({
        to: submitterEmail,
        from_name: 'CTP Flexibles Compliance',
        subject: `❌ Document Requires Revision: ${templateName}`,
        body: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#dc2626;padding:20px;border-radius:8px 8px 0 0;">
              <h2 style="color:white;margin:0;">Document Requires Revision</h2>
            </div>
            <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
              <p style="color:#374151;margin-top:0;">Your document template has been <strong>returned for revision</strong>. Please address the feedback below and resubmit.</p>
              <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
                <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Document</td><td style="padding:8px 0;font-weight:600;color:#111827;">${templateName}</td></tr>
              </table>
              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px;">
                <p style="color:#991b1b;font-weight:600;margin:0 0 6px;">Reason for rejection:</p>
                <p style="color:#7f1d1d;margin:0;">${rejectionReason || 'No reason provided'}</p>
              </div>
              <p style="color:#6b7280;font-size:13px;margin-top:16px;">Log in to the Compliance Tracker to update the document and resubmit for approval.</p>
            </div>
          </div>
        `
      });
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});