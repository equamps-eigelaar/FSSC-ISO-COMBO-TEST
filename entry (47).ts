import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { subject, startTime, endTime, attendees = [], description = "" } = await req.json();

    const { accessToken } = await base44.asServiceRole.connectors.getConnection("microsoft_teams");

    const meetingBody = {
      subject,
      startDateTime: startTime,
      endDateTime: endTime,
      ...(description && { body: { contentType: "text", content: description } }),
    };

    const response = await fetch("https://graph.microsoft.com/v1.0/me/onlineMeetings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(meetingBody),
    });

    if (!response.ok) {
      const err = await response.json();
      return Response.json({ error: err.error?.message || "Failed to create meeting" }, { status: response.status });
    }

    const meeting = await response.json();
    return Response.json({
      joinUrl: meeting.joinWebUrl,
      meetingId: meeting.id,
      subject: meeting.subject,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});