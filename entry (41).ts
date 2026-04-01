import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import crypto from 'crypto';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is admin or auditor
    if (!['admin', 'auditor'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: Only admins and auditors can share proprietary information' }, { status: 403 });
    }

    const { document_id, document_name, share_type, recipients, notes, link_expires_days = 30 } = await req.json();

    if (!document_id || !document_name || !share_type || !recipients) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Generate secure sharing link
    const shareToken = crypto.randomUUID();
    const linkExpiresAt = new Date();
    linkExpiresAt.setDate(linkExpiresAt.getDate() + link_expires_days);

    // Create the proprietary share record
    const share = await base44.entities.ProprietaryShare.create({
      document_id,
      document_name,
      share_type,
      recipients: recipients.map(r => ({
        recipient_email: r.email,
        recipient_type: r.type,
        access_level: r.access_level || 'view_only',
        shared_date: new Date().toISOString(),
        expiry_date: r.expiry_date
      })),
      shared_by: user.email,
      share_date: new Date().toISOString(),
      sharing_link: shareToken,
      link_expires_at: linkExpiresAt.toISOString(),
      notes,
      status: 'active'
    });

    // Send notifications to internal recipients
    const internalRecipients = recipients.filter(r => r.type === 'internal');
    for (const recipient of internalRecipients) {
      await base44.functions.invoke('sendProprietaryShareNotification', {
        share_id: share.id,
        recipient_email: recipient.email,
        document_name,
        shared_by: user.full_name,
        share_type
      });
    }

    return Response.json({
      share_id: share.id,
      sharing_link: shareToken,
      link_expires_at: linkExpiresAt.toISOString(),
      message: 'Proprietary share created successfully'
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});