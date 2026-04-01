import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 24);
    const cutoffISO = cutoffDate.toISOString();

    // Fetch logs older than 24 months (paginate in batches of 200)
    let archived = 0;
    let deleted = 0;
    let page = 0;
    const batchSize = 200;

    while (true) {
      const logs = await base44.asServiceRole.entities.ActivityLog.list(
        'created_date',
        batchSize,
        page * batchSize
      );

      const oldLogs = logs.filter(l => l.created_date < cutoffISO);

      if (oldLogs.length === 0) break;

      // Archive each log
      for (const log of oldLogs) {
        await base44.asServiceRole.entities.ActivityLogArchive.create({
          original_id: log.id,
          activity_type: log.activity_type,
          entity_type: log.entity_type,
          entity_id: log.entity_id,
          entity_label: log.entity_label,
          description: log.description,
          metadata: log.metadata,
          field_changes: log.field_changes,
          user_email: log.user_email,
          user_name: log.user_name,
          ip_address: log.ip_address,
          original_created_date: log.created_date,
          archived_date: new Date().toISOString(),
        });
        archived++;

        await base44.asServiceRole.entities.ActivityLog.delete(log.id);
        deleted++;
      }

      // If we got fewer than batchSize, no more pages
      if (logs.length < batchSize) break;
      page++;
    }

    return Response.json({
      success: true,
      cutoff_date: cutoffISO,
      records_archived: archived,
      records_deleted: deleted,
    });

  } catch (error) {
    console.error('Archive activity logs error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});