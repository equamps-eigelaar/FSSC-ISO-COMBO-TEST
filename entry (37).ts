import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Verify the user is authenticated and use their email from the session
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { notification_type } = await req.json();

    if (!notification_type) {
      return Response.json({ error: 'Missing required field: notification_type' }, { status: 400 });
    }

    // Use the authenticated user's email — never trust user_email from payload
    const preferences = await base44.asServiceRole.entities.NotificationPreference.filter({
      user_email: user.email
    });

    if (preferences.length === 0) {
      return Response.json({ should_notify: true, preference_exists: false });
    }

    const pref = preferences[0];
    const shouldNotify = pref[notification_type] !== false;

    return Response.json({
      should_notify: shouldNotify,
      preference_exists: true,
      preferences: pref
    });
  } catch (error) {
    console.error('Error checking preferences:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});