import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();

  if (user?.role !== 'admin') {
    return Response.json({ error: 'Admin only' }, { status: 403 });
  }

  const { user_email, organization_id, organization_name } = await req.json();

  if (!user_email || !organization_id) {
    return Response.json({ error: 'user_email and organization_id required' }, { status: 400 });
  }

  // Find the user record
  const users = await base44.asServiceRole.entities.User.filter({ email: user_email });
  if (!users || users.length === 0) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  await base44.asServiceRole.entities.User.update(users[0].id, {
    organization_id,
    organization_name: organization_name || '',
  });

  return Response.json({ success: true, user_email, organization_id });
});