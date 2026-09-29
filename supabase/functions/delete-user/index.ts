import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  // Answer the browser's CORS preflight request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();
    if (!userId) {
      return json({ error: "Missing userId" }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Privileged client for the checks and the deletion.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Identify the caller from their own JWT.
    const token = authHeader.replace("Bearer ", "");
    const { data: callerUser, error: callerErr } = await adminClient.auth.getUser(token);
    if (callerErr || !callerUser?.user) {
      return json({ error: "Invalid session" }, 401);
    }

    const { data: callerProfile, error: callerProfileErr } = await adminClient
      .from("profiles")
      .select("role, organization_id")
      .eq("id", callerUser.user.id)
      .single();

    if (callerProfileErr || !callerProfile || callerProfile.role !== "admin") {
      return json({ error: "Not authorized" }, 403);
    }

    const { data: targetProfile, error: targetErr } = await adminClient
      .from("profiles")
      .select("organization_id")
      .eq("id", userId)
      .single();

    if (targetErr || !targetProfile || targetProfile.organization_id !== callerProfile.organization_id) {
      return json({ error: "User not found in your organization" }, 404);
    }

    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(userId);
    if (deleteErr) {
      return json({ error: deleteErr.message }, 400);
    }

    return json({ success: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
