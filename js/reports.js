import { mountLayout, sectionHead } from "./layout.js";
import { supabase, friendlyError } from "./supabase-client.js";
import { showToast } from "./toast.js";

const profile = await mountLayout({ activeKey: "reports", pageTitle: "Reports", allowedRoles: ["admin"] });
if (!profile) throw new Error("redirecting");

function localDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

document.getElementById("export-head").innerHTML = sectionHead({
  title: "Attendance export",
  tone: "primary",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
});
document.getElementById("more-head").innerHTML = sectionHead({
  title: "More reports",
  tone: "muted",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>`,
});

const fromInput = document.getElementById("from-date");
const toInput = document.getElementById("to-date");

// Export button lives in the section header, top right
const exportBtn = document.createElement("button");
exportBtn.type = "button";
exportBtn.id = "export-btn";
exportBtn.className = "icon-action sm";
exportBtn.title = "Export CSV";
exportBtn.setAttribute("aria-label", "Export CSV");
exportBtn.style.marginLeft = "auto";
exportBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/></svg>`;
const exportHead = document.getElementById("export-head");
(exportHead.querySelector(".section-head") || exportHead).appendChild(exportBtn);

const now = new Date();
fromInput.value = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
toInput.value = localDate(now);

exportBtn.addEventListener("click", async () => {
  const from = fromInput.value;
  const to = toInput.value;
  if (!from || !to || new Date(to) < new Date(from)) {
    showToast("Please choose a valid date range.", "error");
    return;
  }

  exportBtn.disabled = true;

  try {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("record_date, status, time_in, break_out, break_in, time_out, source, profiles!profile_id(full_name, role)")
      .eq("organization_id", profile.organization_id)
      .gte("record_date", from)
      .lte("record_date", to)
      .order("record_date", { ascending: true });
    if (error) throw error;

    if (!data || data.length === 0) {
      showToast("No attendance records found in that range.", "info");
      return;
    }

    downloadCsv(data, from, to);
    showToast("Export downloaded.", "success");
  } catch (err) {
    console.error(err);
    showToast(friendlyError(err, "Unable to export attendance right now."), "error");
  } finally {
    exportBtn.disabled = false;
  }
});

function downloadCsv(rows, from, to) {
  const headers = ["Date", "Name", "Role", "Status", "Time in", "Break out", "Break in", "Time out", "Source"];
  const lines = [headers.join(",")];

  rows.forEach((r) => {
    lines.push(
      [r.record_date, csvSafe(r.profiles?.full_name || ""), r.profiles?.role || "", r.status || "", r.time_in || "", r.break_out || "", r.break_in || "", r.time_out || "", r.source || ""].join(",")
    );
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attendance-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvSafe(value) {
  const str = String(value);
  return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
}
