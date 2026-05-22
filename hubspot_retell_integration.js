/**
 * ═══════════════════════════════════════════════════════════════════════
 * EUROPEMOBILE × RETELL AI — HUBSPOT CUSTOM FUNCTIONS
 * Version: v4.2 — Hardening: lookup_tickets_for_dedupe + get_deal_status
 * Basis: v4.1 (Inzahlungnahme-Intent)
 * 
 * CHANGES gegenüber v4.1:
 * - lookup_tickets_for_dedupe: Pflichtfeld-Validierung, kein 400 mehr
 * - lookup_tickets_for_dedupe: status-Filter clientseitig statt serverseitig
 * - get_deal_status: Retry ohne contact_id-Filter falls HubSpot 400 wirft
 * - Alle Tool-Errors liefern ab jetzt actionable JSON statt nackten Errors
 * ═══════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const hs = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

const CONFIG = {
  PIPELINES: {
    auslieferung:        '749565507',
    support:             '0',
    lieferstatus:        '13587217',
    leasingruecklaufer:  '9482609',
    lead_abwicklung:     '45415425',
    selbstauskunft:      '876438887',
  },
  STAGES: {
    support_rechtsanwalt: '36992161',
  },
  OWNERS: {
    SALES_A:        '13507121',
    SALES_B:        '13507124',
    SALES_C:        '83220033',
    SALES_D:        '51180404',
    ORGANISATION:   '13507107',
    HELPDESK:       '13507107',
    LOGISTIK:       '70800857',
    BUCHHALTUNG:    '69995518',
    ZULASSUNG:      '78387480',
  },
  BUSINESS_HOURS: {
    morningStart: 8.5,
    morningEnd: 12,
    afternoonStart: 13,
    afternoonEnd: 17,
    days: [1,2,3,4,5]
  },
};

function normalizePhone(phone) {
  if (!phone) return '';
  let n = String(phone).replace(/[\s\-\(\)\.]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (n.startsWith('0') && !n.startsWith('00')) n = '+49' + n.slice(1);
  return n;
}

function buildPhoneVariants(input) {
  if (!input) return [];
  const clean = String(input).replace(/[\s\-\(\)\.\/]/g, '');
  let e164;
  if (clean.startsWith('+'))         e164 = clean;
  else if (clean.startsWith('00'))   e164 = '+' + clean.slice(2);
  else if (clean.startsWith('0'))    e164 = '+49' + clean.slice(1);
  else                                e164 = '+' + clean;
  const digits = e164.slice(1);
  if (digits.length < 6) return [e164];
  const variants = new Set();
  variants.add(e164);
  variants.add(digits);
  variants.add('0' + digits.slice(2));
  if (digits.startsWith('49') && digits.length >= 5) {
    const cc   = digits.slice(0, 2);
    const area = digits.slice(2, 5);
    const rest = digits.slice(5);
    variants.add(`+${cc} ${area} ${rest}`);
    variants.add(`+${cc} ${area}${rest}`);
    variants.add(`0${area} ${rest}`);
    variants.add(`+${cc}-${area}-${rest}`);
    variants.add(`(0${area}) ${rest}`);
  }
  return [...variants];
}

async function robustContactLookup({ phone, email }) {
  const variants = buildPhoneVariants(phone);
  const props = ['firstname','lastname','email','phone','mobilephone',
                 'hubspot_owner_id','em_ai_opt_out_ki_calls','em_ai_call_status'];
  for (const variant of variants) {
    for (const field of ['phone', 'mobilephone']) {
      try {
        const r = await hs.post('/crm/v3/objects/contacts/search', {
          filterGroups: [{ filters: [{ propertyName: field, operator: 'EQ', value: variant }] }],
          properties: props, limit: 1
        });
        if (r.data.results?.length > 0) {
          console.log(`[lookup_contact] Match via ${field}="${variant}"`);
          return r.data.results[0];
        }
      } catch (e) {
        console.log(`[lookup_contact] Search error ${field}="${variant}": ${e.message}`);
      }
    }
  }
  if (phone) {
    const digitsOnly = String(phone).replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 7) {
      const lastSeven = digitsOnly.slice(-7);
      for (const field of ['phone', 'mobilephone']) {
        try {
          const r = await hs.post('/crm/v3/objects/contacts/search', {
            filterGroups: [{ filters: [{ propertyName: field, operator: 'CONTAINS_TOKEN', value: lastSeven }] }],
            properties: props, limit: 1
          });
          if (r.data.results?.length > 0) {
            console.log(`[lookup_contact] Fuzzy match via ${field} CONTAINS "${lastSeven}"`);
            return r.data.results[0];
          }
        } catch {}
      }
    }
  }
  if (email) {
    try {
      const r = await hs.post('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: props, limit: 1
      });
      if (r.data.results?.length > 0) return r.data.results[0];
    } catch {}
  }
  console.log(`[lookup_contact] No match for phone="${phone}" email="${email}"`);
  return null;
}

function isBusinessHours() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours() + now.getMinutes() / 60;
  const bh = CONFIG.BUSINESS_HOURS;
  if (!bh.days.includes(day)) return { open: false, reason: 'weekend_or_holiday' };
  if (hour < bh.morningStart) return { open: false, reason: 'before_open' };
  if (hour >= bh.morningStart && hour < bh.morningEnd) return { open: true, reason: 'morning' };
  if (hour >= bh.morningEnd && hour < bh.afternoonStart) return { open: false, reason: 'lunch_break' };
  if (hour >= bh.afternoonStart && hour < bh.afternoonEnd) return { open: true, reason: 'afternoon' };
  return { open: false, reason: 'after_close' };
}

async function getSalesOwner() {
  for (const id of [CONFIG.OWNERS.SALES_A, CONFIG.OWNERS.SALES_B, CONFIG.OWNERS.SALES_C]) {
    try {
      const r = await hs.post('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [
          { propertyName: 'hubspot_owner_id', operator: 'EQ', value: id },
          { propertyName: 'em_ai_next_step', operator: 'EQ', value: 'sales_callback' }
        ]}], limit: 1
      });
      if ((r.data.total || 0) < 50) return id;
    } catch { return id; }
  }
  return CONFIG.OWNERS.SALES_D;
}

// ═══════════════════════════════════════════════════════════
// DIAGNOSE-ENDPOINT (temporär, später entfernen!)
// ═══════════════════════════════════════════════════════════
app.get('/diag', async (req, res) => {
  const token = process.env.HUBSPOT_ACCESS_TOKEN || '';
  const result = {
    timestamp: new Date().toISOString(),
    server_time_local: new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }),
    timezone_env: process.env.TZ || 'not set',
    business_hours_check: isBusinessHours(),
    token_check: {
      present: !!token,
      length: token.length,
      starts_with: token.substring(0, 15),
      starts_with_pat_na1: token.startsWith('pat-na1-'),
    },
    other_env: {
      transfer_number_set: !!process.env.INTERNAL_TRANSFER_NUMBER,
      transfer_number_value: process.env.INTERNAL_TRANSFER_NUMBER || null,
      port: process.env.PORT || 'not set',
      node_version: process.version,
    },
    hubspot_live_test: null,
  };

  try {
    const testResponse = await axios.get(
      'https://api.hubapi.com/crm/v3/objects/contacts?limit=1',
      { headers: { 'Authorization': `Bearer ${token}` }, timeout: 10000 }
    );
    result.hubspot_live_test = {
      success: true,
      status: testResponse.status,
      contacts_count: testResponse.data.results?.length || 0,
    };
  } catch (e) {
    result.hubspot_live_test = {
      success: false,
      status: e.response?.status || 'no_response',
      error_message: e.response?.data?.message || e.message,
    };
  }

  res.json(result);
});

// ═══════════════════════════════════════════════════════════
// Custom Functions F1-F11
// ═══════════════════════════════════════════════════════════

// F1: lookup_contact
app.post('/retell/lookup_contact', async (req, res) => {
  const { phone, email } = req.body;
  try {
    const contact = await robustContactLookup({ phone, email });
    if (!contact) return res.json({ found: false, message: 'Neuer Interessent.' });
    const p = contact.properties;
    if (p.em_ai_opt_out_ki_calls === 'true') return res.json({
      found: true, contact_id: contact.id, opt_out: true,
      message: 'STOPP: Opt-out aktiv. Gespräch sofort beenden.'
    });
    return res.json({
      found: true, contact_id: contact.id, opt_out: false,
      firstname: p.firstname || '', lastname: p.lastname || '',
      email: p.email || '', phone: p.phone || p.mobilephone || '',
      greeting: p.firstname ? `Guten Tag ${p.firstname} ${p.lastname||''}`.trim() : 'Guten Tag'
    });
  } catch (e) { res.json({ found: false, error: e.message }); }
});

// F2: create_contact
app.post('/retell/create_contact', async (req, res) => {
  const { firstname, lastname, phone, email, intent } = req.body;
  try {
    const ownerId = await getSalesOwner();
    const r = await hs.post('/crm/v3/objects/contacts', { properties: {
      firstname: firstname || '', lastname: lastname || '',
      phone: normalizePhone(phone), email: email || '',
      hubspot_owner_id: ownerId,
      em_ai_call_status: 'reached',
      em_ai_next_step: 'sales_callback',
      em_ai_channel: 'phone',
    }});
    res.json({ success: true, contact_id: r.data.id, assigned_owner: ownerId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// F3: get_deal_status — mit Retry-Logik bei 400-Fehlern (v4.2)
// ═══════════════════════════════════════════════════════════
async function searchDealsWithFallback(filters, baseProps) {
  try {
    return await hs.post('/crm/v3/objects/deals/search', {
      filterGroups: [{ filters }],
      properties: baseProps,
      limit: 5
    });
  } catch (e) {
    if (e.response?.status === 400) {
      const fallbackFilters = filters.filter(f => f.propertyName !== 'associations.contact');
      if (fallbackFilters.length > 0 && fallbackFilters.length < filters.length) {
        console.log('[get_deal_status] Retry ohne associations.contact-Filter');
        return await hs.post('/crm/v3/objects/deals/search', {
          filterGroups: [{ filters: fallbackFilters }],
          properties: baseProps,
          limit: 5
        });
      }
    }
    throw e;
  }
}

app.post('/retell/get_deal_status', async (req, res) => {
  const { contact_id, order_number, verification_level, vehicle_brand, vehicle_model } = req.body;

  if (parseInt(verification_level) < 3) return res.json({
    success: false,
    reason: 'verification_required',
    message: 'Verifikationsstufe 3 erforderlich.'
  });

  const hasOrderNumber = !!(order_number && String(order_number).trim());
  const hasBrandModel  = !!(vehicle_brand && vehicle_model && contact_id);

  if (!hasOrderNumber && !hasBrandModel) return res.json({
    success: false,
    reason: 'missing_search_criteria',
    message: 'Weder Ordernummer noch Hersteller+Modell+Contact-ID übermittelt. Anrufer um Ordernummer bitten oder Marke und Modell erfragen.'
  });

  try {
    const filters = [];
    if (hasOrderNumber) {
      filters.push({ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: String(order_number).trim() });
    } else {
      filters.push({ propertyName: 'vehicle_brand', operator: 'CONTAINS_TOKEN', value: vehicle_brand });
      filters.push({ propertyName: 'vehicle_model', operator: 'CONTAINS_TOKEN', value: vehicle_model });
    }
    if (contact_id) filters.push({ propertyName: 'associations.contact', operator: 'EQ', value: String(contact_id) });

    const props = ['dealname','dealstage','amount','expected_delivery_date','vehicle_brand','vehicle_model'];
    const r = await searchDealsWithFallback(filters, props);

    if (!r.data.results?.length) return res.json({
      success: false,
      reason: 'no_match',
      searched_by: hasOrderNumber ? 'order_number' : 'brand_model',
      message: hasOrderNumber
        ? 'Zu der genannten Ordernummer wurde kein Deal gefunden. Anrufer fragen, ob er die Nummer nochmal prüfen kann ODER ob ein Ticket angelegt werden soll, damit das Logistik-Team sich meldet.'
        : 'Zu Hersteller und Modell wurde kein Deal gefunden. Anrufer fragen, ob ein Ticket angelegt werden soll.'
    });

    if (r.data.results.length === 1) {
      const p = r.data.results[0].properties;
      return res.json({
        success: true,
        deal_id: r.data.results[0].id,
        dealname: p.dealname || '',
        stage: p.dealstage || '',
        vehicle: `${p.vehicle_brand||''} ${p.vehicle_model||''}`.trim(),
        expected_delivery: p.expected_delivery_date || 'Noch nicht bestätigt',
      });
    }

    return res.json({
      success: true,
      multiple_matches: true,
      count: r.data.results.length,
      message: `${r.data.results.length} mögliche Treffer. Anrufer um genauere Angaben bitten (z.B. Fahrzeugmarke).`,
      deals: r.data.results.map(d => ({
        deal_id: d.id,
        dealname: d.properties.dealname || '',
        vehicle: `${d.properties.vehicle_brand||''} ${d.properties.vehicle_model||''}`.trim(),
        stage: d.properties.dealstage || '',
      }))
    });
  } catch (e) {
    console.log(`[get_deal_status] Fehler: ${e.response?.status} ${e.response?.data?.message || e.message}`);
    res.json({
      success: false,
      reason: 'hubspot_error',
      message: 'Es gab ein technisches Problem beim Abfragen. Anrufer informieren, dass das Logistik-Team sich per Ticket meldet, und dann create_ticket aufrufen.',
      error: e.response?.data?.message || e.message
    });
  }
});

// F4: add_call_note
app.post('/retell/add_call_note', async (req, res) => {
  const { contact_id, deal_id, category, intent, summary,
          next_step, open_points, verification_level,
          channel, special_case, callback_time } = req.body;
  const body = [
    `[KI-Notiz ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}]`,
    `Kanal: ${channel||'PHONE'} | Kategorie: ${category||'SALES'} | Intent: ${intent||''}`,
    `Verifikation: Stufe ${verification_level||1}`,
    `\nZusammenfassung:\n${summary||''}`,
    `\nOffene Punkte: ${open_points||'Keine'}`,
    `Nächster Schritt: ${next_step||''}`,
    callback_time ? `Rückruf: ${callback_time}` : '',
    special_case ? '⚠ SONDERFALL' : '',
  ].filter(Boolean).join('\n');
  try {
    const note = await hs.post('/crm/v3/objects/notes', {
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() }
    });
    if (contact_id) await hs.put(`/crm/v3/objects/notes/${note.data.id}/associations/contacts/${contact_id}/note_to_contact`, {});
    if (deal_id) await hs.put(`/crm/v3/objects/notes/${note.data.id}/associations/deals/${deal_id}/note_to_deal`, {});
    if (contact_id) await hs.patch(`/crm/v3/objects/contacts/${contact_id}`, { properties: {
      em_ai_call_status: 'reached',
      em_ai_summary: (summary||'').slice(0,500),
      em_ai_channel: channel||'phone',
      em_ai_last_call_timestamp: new Date().toISOString(),
    }});
    res.json({ success: true, note_id: note.data.id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// F5: create_task
app.post('/retell/create_task', async (req, res) => {
  const { contact_id, subject, body, assigned_team, priority } = req.body;
  const ownerMap = {
    SALES: await getSalesOwner(), SALES_ASSISTANT: CONFIG.OWNERS.SALES_D,
    ORGANISATION: CONFIG.OWNERS.ORGANISATION, HELPDESK: CONFIG.OWNERS.HELPDESK,
    LOGISTIK: CONFIG.OWNERS.LOGISTIK, BUCHHALTUNG: CONFIG.OWNERS.BUCHHALTUNG,
    ZULASSUNG: CONFIG.OWNERS.ZULASSUNG,
  };
  const due = new Date(Date.now() + 86400000); due.setHours(9,0,0,0);
  try {
    const task = await hs.post('/crm/v3/objects/tasks', { properties: {
      hs_task_subject: subject||'Rückruf KI',
      hs_task_body: body||'',
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: priority||'MEDIUM',
      hs_timestamp: due.toISOString(),
      hubspot_owner_id: ownerMap[assigned_team]||await getSalesOwner(),
    }});
    if (contact_id) await hs.put(`/crm/v3/objects/tasks/${task.data.id}/associations/contacts/${contact_id}/task_to_contact`, {});
    res.json({ success: true, task_id: task.data.id, due: due.toLocaleDateString('de-DE') });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// F6: book_appointment
app.post('/retell/book_appointment', async (req, res) => {
  const { contact_id, appointment_type, preferred_date, preferred_time, notes } = req.body;
  const ownerId = await getSalesOwner();
  const due = new Date(Date.now() + 86400000); due.setHours(9,0,0,0);
  try {
    const task = await hs.post('/crm/v3/objects/tasks', { properties: {
      hs_task_subject: `${appointment_type==='callback'?'Rückruf':'Termin'} (KI): ${preferred_date||'nach Absprache'} ${preferred_time||''}`,
      hs_task_body: notes||'Über KI vereinbart',
      hs_task_type: appointment_type==='callback' ? 'CALL' : 'MEETING',
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'HIGH',
      hubspot_owner_id: ownerId,
      hs_timestamp: due.toISOString(),
    }});
    if (contact_id) await hs.put(`/crm/v3/objects/tasks/${task.data.id}/associations/contacts/${contact_id}/task_to_contact`, {});
    res.json({ success: true, task_id: task.data.id, message: `Eingetragen: ${preferred_date||'nach Absprache'} ${preferred_time||''}` });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// F7: create_ticket — Support / Eskalation
// ═══════════════════════════════════════════════════════════
app.post('/retell/create_ticket', async (req, res) => {
  const { contact_id, deal_id, subject, description, intent,
          priority, channel, verification_level, special_case, callback_time } = req.body;
  const intentMap = {
    lieferstatus: { pl: CONFIG.PIPELINES.lieferstatus, owner: CONFIG.OWNERS.LOGISTIK },
    bereitstellung: { pl: CONFIG.PIPELINES.auslieferung, owner: CONFIG.OWNERS.ORGANISATION },
    zulassung: { pl: CONFIG.PIPELINES.auslieferung, owner: CONFIG.OWNERS.ZULASSUNG },
    zahlung: { pl: CONFIG.PIPELINES.support, owner: CONFIG.OWNERS.BUCHHALTUNG },
    rechnung: { pl: CONFIG.PIPELINES.support, owner: CONFIG.OWNERS.BUCHHALTUNG },
    selbstauskunft: { pl: CONFIG.PIPELINES.selbstauskunft, owner: CONFIG.OWNERS.SALES_D },
    leasingruecklaufer: { pl: CONFIG.PIPELINES.leasingruecklaufer, owner: CONFIG.OWNERS.SALES_D },
    reklamation: { pl: CONFIG.PIPELINES.support, owner: CONFIG.OWNERS.HELPDESK },
    anwalt: { pl: CONFIG.PIPELINES.support, owner: CONFIG.OWNERS.HELPDESK },
    lead: { pl: CONFIG.PIPELINES.lead_abwicklung, owner: await getSalesOwner() },
    inzahlungnahme: { pl: CONFIG.PIPELINES.lead_abwicklung, owner: await getSalesOwner() },
  };
  const r = intentMap[intent?.toLowerCase()] || { pl: CONFIG.PIPELINES.support, owner: CONFIG.OWNERS.HELPDESK };
  const body = `${description||''}\n\nKanal: ${channel||'PHONE'} | Stufe: ${verification_level||1} | ${callback_time?'Rückruf: '+callback_time:''} | ${special_case?'⚠ SONDERFALL':''}`.trim();
  try {
    const ticket = await hs.post('/crm/v3/objects/tickets', { properties: {
      subject: subject||`KI: ${intent||'Allgemein'}`,
      content: body,
      hs_pipeline: r.pl,
      hs_pipeline_stage: intent==='anwalt' ? CONFIG.STAGES.support_rechtsanwalt : '1',
      hs_ticket_priority: priority || (special_case ? 'URGENT' : 'MEDIUM'),
      hubspot_owner_id: r.owner,
    }});
    if (contact_id) await hs.put(`/crm/v3/objects/tickets/${ticket.data.id}/associations/contacts/${contact_id}/ticket_to_contact`, {});
    if (deal_id) await hs.put(`/crm/v3/objects/tickets/${ticket.data.id}/associations/deals/${deal_id}/ticket_to_deal`, {});
    res.json({ success: true, ticket_id: ticket.data.id, pipeline: r.pl });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// F8: lookup_tickets_for_dedupe — HARDENED v4.2
// - Pflichtfeld-Validierung VOR HubSpot-Call
// - Status-Filter clientseitig (sicherer)
// - Saubere actionable Antwort bei Fehlern
// ═══════════════════════════════════════════════════════════
app.post('/retell/lookup_tickets_for_dedupe', async (req, res) => {
  const { contact_id, pipeline } = req.body;

  if (!contact_id || !pipeline) {
    return res.json({
      duplicate_found: false,
      reason: 'missing_params',
      message: 'Dedupe-Check ohne contact_id oder pipeline nicht möglich. Direkt mit Ticket-Anlage fortfahren.'
    });
  }

  try {
    const r = await hs.post('/crm/v3/objects/tickets/search', {
      filterGroups: [{ filters: [
        { propertyName: 'associations.contact', operator: 'EQ', value: String(contact_id) },
        { propertyName: 'hs_pipeline', operator: 'EQ', value: String(pipeline) },
      ]}],
      properties: ['subject','hs_pipeline_stage','createdate','hs_ticket_status','hs_pipeline'],
      limit: 5
    });

    if (!r.data.results?.length) {
      return res.json({ duplicate_found: false });
    }

    const openTickets = r.data.results.filter(t => {
      const status = (t.properties.hs_ticket_status || '').toUpperCase();
      const stage = t.properties.hs_pipeline_stage || '';
      return status !== 'CLOSED' && status !== '4' && stage !== '4';
    });

    if (!openTickets.length) {
      return res.json({ duplicate_found: false });
    }

    const t = openTickets[0];
    return res.json({
      duplicate_found: true,
      existing_ticket_id: t.id,
      subject: t.properties.subject || '',
      message: 'Es gibt bereits ein offenes Ticket zu diesem Thema. Anrufer freundlich darauf hinweisen und fragen, ob es zum bestehenden Vorgang gehört.'
    });
  } catch (e) {
    console.log(`[lookup_tickets_for_dedupe] Fehler: ${e.response?.status} ${e.response?.data?.message || e.message}`);
    return res.json({
      duplicate_found: false,
      reason: 'hubspot_error',
      message: 'Dedupe-Check fehlgeschlagen. Trotzdem mit Ticket-Anlage fortfahren.',
      error: e.response?.data?.message || e.message
    });
  }
});

// F9: check_business_hours
app.post('/retell/check_business_hours', (req, res) => {
  const status = isBusinessHours();
  const messages = {
    morning: 'Geschäftszeiten aktiv (vormittags) — Transfer möglich.',
    afternoon: 'Geschäftszeiten aktiv (nachmittags) — Transfer möglich.',
    lunch_break: 'Mittagspause 12:00-13:00 Uhr — kein Transfer, Rückruf nach 13:00 anbieten.',
    before_open: 'Vor Öffnung (vor 8:30) — Rückruf für später am Tag anbieten.',
    after_close: 'Nach Geschäftsschluss (nach 17:00) — Rückruf für nächsten Werktag anbieten.',
    weekend_or_holiday: 'Wochenende oder Feiertag — Rückruf für nächsten Werktag anbieten.',
  };
  res.json({
    is_open: status.open,
    reason: status.reason,
    message: messages[status.reason] || 'Status unbekannt.',
    recommendation: status.open ? 'transfer_to_human aufrufen' : 'book_appointment oder create_task'
  });
});

// F10: set_opt_out
app.post('/retell/set_opt_out', async (req, res) => {
  const { contact_id } = req.body;
  try {
    await hs.patch(`/crm/v3/objects/contacts/${contact_id}`, { properties: {
      em_ai_opt_out_ki_calls: 'true', em_ai_call_status: 'optout'
    }});
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// F11: transfer_to_human
app.post('/retell/transfer_to_human', async (req, res) => {
  const { contact_id, reason, urgency } = req.body;
  const transferNumber = process.env.INTERNAL_TRANSFER_NUMBER;
  if (!transferNumber) {
    return res.json({ success: false, transfer_possible: false,
      message: 'Keine Transfer-Nummer konfiguriert.', fallback: 'create_task' });
  }
  const status = isBusinessHours();
  if (!status.open) {
    const reasonMessages = {
      lunch_break: 'Mittagspause bis 13:00 Uhr — Transfer aktuell nicht möglich.',
      before_open: 'Vor Geschäftsöffnung — Transfer aktuell nicht möglich.',
      after_close: 'Nach Geschäftsschluss — Transfer aktuell nicht möglich.',
      weekend_or_holiday: 'Wochenende oder Feiertag — Transfer aktuell nicht möglich.',
    };
    return res.json({
      success: false,
      transfer_possible: false,
      reason: status.reason,
      message: reasonMessages[status.reason] || 'Außerhalb der Geschäftszeiten.',
      fallback: 'book_appointment'
    });
  }
  if (contact_id) {
    try {
      await hs.patch(`/crm/v3/objects/contacts/${contact_id}`, { properties: {
        em_ai_call_status: 'transferred',
        em_ai_next_step: 'human_handoff',
        em_ai_last_call_timestamp: new Date().toISOString(),
      }});
    } catch (e) { console.log(`[Transfer] HubSpot-Update fehlgeschlagen: ${e.message}`); }
  }
  res.json({ success: true, transfer_possible: true,
    transfer_number: transferNumber,
    message: 'Ich verbinde Sie jetzt mit einem Kollegen aus dem Team.' });
});

// Post-Call-Webhook
app.post('/retell/post-call-webhook', async (req, res) => {
  console.log(`[Post-Call] ${req.body.call_id} — Status: ${req.body.call_status}`);
  res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', functions: 11, version: 'v4.2' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Retell Integration v4.2 läuft auf Port ${PORT}`));
