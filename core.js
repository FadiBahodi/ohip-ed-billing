(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FolioCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function csvCell(value) {
    let s = String(value ?? "");
    if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }
  function line(codes) {
    return codes
      .map((c) => c.code + (c.units > 1 ? " ×" + c.units : ""))
      .join(" + ");
  }
  function csv(rows) {
    const header = [
      "encounter_id",
      "reference",
      "service_date",
      "time",
      "payer",
      "role",
      "codes",
      "critical_minutes",
      "critical_time_basis",
      "rule_package",
      "critical_intervals",
      "status",
    ];
    return [
      header,
      ...rows.map((r) => [
        r.encounterId,
        r.reference,
        r.date,
        r.time,
        r.payer,
        r.role,
        line(r.codes),
        r.criticalMinutes,
        r.criticalTimeBasis || "",
        r.ruleVersion || "",
        (r.criticalIntervals || [])
          .map(
            (x) =>
              new Date(x.start * 60000).toISOString().slice(0, 16) +
              "/" +
              new Date(x.end * 60000).toISOString().slice(0, 16),
          )
          .join("; "),
        r.status,
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n");
  }
  function cleanRow(r, D) {
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.encounterId !== "string" ||
      !r.encounterId ||
      r.encounterId.length > 100 ||
      typeof r.reference !== "string" ||
      !r.reference.trim() ||
      r.reference.length > 80 ||
      !Array.isArray(r.codes) ||
      r.codes.length > 60
    )
      throw Error("Invalid encounter record.");
    const codes = r.codes.map((c) => {
      if (
        !c ||
        !D.codes.some((x) => x.code === c.code) ||
        !Number.isInteger(c.units) ||
        c.units < 1 ||
        c.units > 999
      )
        throw Error("Unknown code or invalid units.");
      return {
        code: c.code,
        units: c.units,
        ...(Number.isInteger(c.timeUnits) ? { timeUnits: c.timeUnits } : {}),
      };
    });
    if (new Set(codes.map((c) => c.code)).size !== codes.length)
      throw Error("Duplicate code in encounter.");
    const validDate = (s) =>
      s === null ||
      s === "" ||
      (typeof s === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(s) &&
        Number.isFinite(Date.parse(s + "T00:00Z")) &&
        new Date(s + "T00:00Z").toISOString().slice(0, 10) === s);
    const date = r.date ?? null,
      time = r.time ?? null;
    if (
      !validDate(date) ||
      !(
        time === null ||
        time === "" ||
        (typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      )
    )
      throw Error("Invalid encounter date or time.");
    const criticalIntervals = (r.criticalIntervals || []).map((x) => {
      if (
        !Number.isFinite(x.start) ||
        !Number.isFinite(x.end) ||
        x.start >= x.end ||
        x.end - x.start > 1440
      )
        throw Error("Invalid critical-care interval.");
      return { start: x.start, end: x.end };
    });
    if (criticalIntervals.length > 100) throw Error("Too many intervals.");
    const criticalTimeBasis = ["documented", "estimated", "confirmed"].includes(
      r.criticalTimeBasis,
    )
      ? r.criticalTimeBasis
      : r.criticalMinutes
        ? "documented"
        : null;
    const criticalProposed =
      r.criticalProposed === true || criticalTimeBasis === "estimated";
    const reviewed = r.reviewed === true && !criticalProposed;
    return {
      encounterId: r.encounterId,
      reference: r.reference.trim(),
      date,
      time,
      payer: ["ohip", "wsib", "selfpay", "unknown"].includes(r.payer)
        ? r.payer
        : "unknown",
      role: [
        "primary",
        "procedure_only",
        "sedation",
        "assistant",
        "handover",
      ].includes(r.role)
        ? r.role
        : "primary",
      codes,
      criticalMinutes: Number.isFinite(r.criticalMinutes)
        ? r.criticalMinutes
        : null,
      criticalIntervals,
      ruleVersion:
        typeof r.ruleVersion === "string" ? r.ruleVersion.slice(0, 100) : null,
      criticalTimeBasis,
      criticalProposed,
      periodKey:
        typeof r.periodKey === "string" ? r.periodKey.slice(0, 100) : null,
      specialVisit: r.specialVisit === true,
      tripId: typeof r.tripId === "string" ? r.tripId.slice(0, 80) : null,
      travelClaimed: r.travelClaimed === true,
      reviewed,
      status: criticalProposed
        ? "PROPOSED TIMING"
        : reviewed
          ? "REVIEWED DRAFT"
          : "HOLD",
      savedAt: typeof r.savedAt === "string" ? r.savedAt.slice(0, 40) : "",
      version: "folio-1",
    };
  }
  function importBackup(input, D) {
    if (
      !input ||
      input.version !== 1 ||
      !Array.isArray(input.ledger) ||
      input.ledger.length > 3000
    )
      throw Error("Use a Folio version 1 backup.");
    const rows = input.ledger.map((r) => cleanRow(r, D));
    if (new Set(rows.map((r) => r.encounterId)).size !== rows.length)
      throw Error("Duplicate encounter IDs in backup.");
    return {
      version: 1,
      shiftName:
        typeof input.shiftName === "string"
          ? input.shiftName.slice(0, 80)
          : "My shift",
      ledger: rows,
    };
  }
  function mergeRows(current, incoming) {
    const map = new Map(current.map((r) => [r.encounterId, r]));
    for (const r of incoming) map.set(r.encounterId, r);
    return [...map.values()];
  }
  function search(query, D, F) {
    const q = query.toLowerCase().trim();
    if (!q)
      return D.codes.map((c) => ({
        kind: "code",
        id: c.code,
        title: c.label,
        codes: [c.code],
        rule_ids: c.rule_ids,
        score: 0,
      }));
    const hits = F.semanticSearch(q, D, 500);
    const map = new Map(hits.map((h) => [h.kind + ":" + h.id, h]));
    const tokens = q
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    for (const c of D.codes) {
      const content = (c.code + " " + c.label + " " + c.topic).toLowerCase();
      const match = tokens.every((t) => content.includes(t));
      if (match) {
        const id = "code:" + c.code;
        map.set(id, {
          kind: "code",
          id: c.code,
          title: c.label,
          codes: [c.code],
          rule_ids: c.rule_ids,
          score:
            c.code.toLowerCase() === q ? 150 : content.includes(q) ? 80 : 70,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 70);
  }
  return { csvCell, line, csv, cleanRow, importBackup, mergeRows, search };
});
