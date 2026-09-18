import { mountLayout } from "./layout.js";
import { supabase, friendlyError } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "reports", pageTitle: "Reports", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

const fromInput = document.getElementById("from-date");
const toInput = document.getElementById("to-date");
const exportBtn = document.getElementById("export-btn");

// Default to the current month.
const now = new Date();
fromInput.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
toInput.value = now.toISOString().slice(0, 10);

exportBtn.addEventListener("click", async () => {
  const from = fromInput.value;
  const to = toInput.value;
  if (!from || !to || new Date(to) < new Date(from)) {
    showToast("Please choose a valid date range.", "error");
    return;
  }

  exportBtn.disabled = true;
  exportBtn.textContent = "Preparing…";

  try {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("record_date, status, time_in, break_out, break_in, time_out, source, profiles(full_name, role)")
      .eq("organization_id", profile.organization_id)
      .gte("record_date", from)
      .lte("record_date", to)
      .order("record_date", { ascending: true });
    if (error) throw error;

    if (!data || data.length === 0) {
      showToast("No attendance records found in that range.", "info");
      return;
    }

    downloadCsv(data);
    showToast("Export downloaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to export attendance right now."), "error");
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = "Export CSV";
  }
});

function downloadCsv(rows) {
  const headers = ["Date", "Name", "Role", "Status", "Time in", "Break out", "Break in", "Time out", "Source"];
  const lines = [headers.join(",")];

  rows.forEach((r) => {
    lines.push(
      [
        r.record_date,
        csvSafe(r.profiles?.full_name || ""),
        r.profiles?.role || "",
        r.status || "",
        r.time_in || "",
        r.break_out || "",
        r.break_in || "",
        r.time_out || "",
        r.source || "",
      ].join(",")
    );
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attendance-${fromInput.value}-to-${toInput.value}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvSafe(value) {
  const str = String(value);
  return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
}
