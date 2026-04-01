import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Support both direct calls (admin) and scheduled automation (no session)
    const isAuthenticated = await base44.auth.isAuthenticated();
    if (isAuthenticated) {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
    }

    const now = new Date();
    const warningDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [allDocuments, allUsers] = await Promise.all([
      base44.asServiceRole.entities.Document.list('-created_date', 500),
      base44.asServiceRole.entities.User.list(),
    ]);

    // Documents expiring within the next 30 days
    const expiringDocs = allDocuments.filter(doc => {
      if (!doc.expiry_date) return false;
      const expiry = new Date(doc.expiry_date);
      return expiry >= now && expiry <= warningDate;
    });

    if (expiringDocs.length === 0) {
      return Response.json({ success: true, expiring_documents: 0, notifications_sent: 0, emails_sent: 0 });
    }

    // Collect compliance manager emails
    const complianceManagerEmails = allUsers
      .filter(u => u.role === 'compliance_manager' || u.role === 'admin')
      .map(u => u.email)
      .filter(Boolean);

    let notificationsSent = 0;
    let emailsSent = 0;

    for (const doc of expiringDocs) {
      const daysUntilExpiry = Math.ceil((new Date(doc.expiry_date) - now) / (1000 * 60 * 60 * 24));
      const expiryFormatted = new Date(doc.expiry_date).toLocaleDateString('en-ZA');

      // Build the set of recipients: document uploader + compliance managers
      const recipientEmails = new Set([
        ...(doc.uploaded_by ? [doc.uploaded_by] : []),
        ...complianceManagerEmails,
      ]);

      for (const email of recipientEmails) {
        // Check if we already sent an in-app notification for this doc in the last 7 days
        const recent = await base44.asServiceRole.entities.Notification.filter({
          recipient_email: email,
          entity_type: 'Document',
          entity_id: doc.id,
          type: 'document_review',
        }, '-created_date', 1);

        const alreadyNotified = recent.length > 0 &&
          (now - new Date(recent[0].created_date)) / (1000 * 60 * 60 * 24) < 7;

        if (alreadyNotified) continue;

        // In-app notification
        await base44.asServiceRole.entities.Notification.create({
          recipient_email: email,
          title: `Document Expiring in ${daysUntilExpiry} Day${daysUntilExpiry !== 1 ? 's' : ''}`,
          message: `"${doc.title || doc.file_name}" expires on ${expiryFormatted}. Please review and renew before expiry.`,
          type: 'document_review',
          entity_type: 'Document',
          entity_id: doc.id,
          priority: daysUntilExpiry <= 7 ? 'critical' : daysUntilExpiry <= 14 ? 'high' : 'normal',
          is_read: false,
        });
        notificationsSent++;

        // Email notification
        await base44.asServiceRole.integrations.Core.SendEmail({
          to: email,
          subject: `⚠️ Document Expiring in ${daysUntilExpiry} Day${daysUntilExpiry !== 1 ? 's' : ''}: ${doc.title || doc.file_name}`,
          body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">
  <div style="background:#d97706;padding:20px 28px">
    <h2 style="color:white;margin:0;font-size:18px">⚠️ Document Expiry Notice</h2>
    <p style="color:#fef3c7;margin:6px 0 0;font-size:13px">Action required — document renewal needed</p>
  </div>
  <div style="padding:28px;background:white">
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-left:4px solid #d97706;border-radius:6px;padding:14px 16px;margin-bottom:20px">
      <p style="margin:0 0 4px;font-weight:bold;color:#1e293b;font-size:15px">${doc.title || doc.file_name}</p>
      <p style="margin:0;color:#64748b;font-size:13px">Category: ${doc.category?.replace(/_/g, ' ') || 'N/A'} &nbsp;|&nbsp; Expires: <strong style="color:#d97706">${expiryFormatted}</strong> (${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''} remaining)</p>
    </div>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      This document is due to expire on <strong>${expiryFormatted}</strong>. Please log in to the FSMS Compliance Tracker to review, renew, or replace this document before it expires to maintain compliance.
    </p>
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;border-top:1px solid #f1f5f9;padding-top:12px">
      FSMS Compliance Tracker — Automated Document Expiry Monitor
    </p>
  </div>
</div>`,
        });
        emailsSent++;
      }
    }

    console.log(`checkExpiringDocuments: expiring=${expiringDocs.length}, notifications=${notificationsSent}, emails=${emailsSent}`);

    return Response.json({
      success: true,
      expiring_documents: expiringDocs.length,
      notifications_sent: notificationsSent,
      emails_sent: emailsSent,
    });

  } catch (error) {
    console.error('checkExpiringDocuments error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});