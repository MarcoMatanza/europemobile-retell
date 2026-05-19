/**
 * ═══════════════════════════════════════════════════════════════════════
 * EUROPEMOBILE × RETELL AI — HUBSPOT CUSTOM FUNCTIONS
 * Deploy: Railway / Render / Vercel
 * Alle Endpoints: https://[deine-domain]/retell/[function-name]
 * Version: v2 — Robuste Telefonnummer-Suche mit mehreren Format-Varianten
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
    SALES_A:        '13507121',  // Raphael Matanza (primär)
    SALES_B:        '13507124',  // Sebastian Dudas
    SALES_C:        '83220033',  // Andreas Tzeretas
    SALES_D:        '51180404',  // Gabriele Eder (Fallback)
    ORGANISATION:   '13507107',  // Thomas Abfalter
    HELPDESK:       '13507107',  // Thomas Abfalter
    LOGISTIK:       '70800857',  // Fabian Stein
    BUCHHALTUNG:    '69995518',  // Jasmin Burkl
    ZULASSUNG:      '78387480',  // Alina Klersy
  },
  BUSINESS_HOURS: { start: 8.5, end: 17, days: [1,2,3,4,5] },
};

// ─── HILFSFUNKTIONEN ─────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return '';
  let n = String(phone).replace(/[\s\-\(\)\.]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (n.startsWith('0') && !n.startsWith('00')) n = '+49' + n.slice(1);
  return n;
}

/**
 * Erzeugt verschiedene Telefonnummer-Formate für die HubSpot-Suche.
 * HubSpot speichert Nummern oft mit Leerzeichen (z.B. "+49 179 2340447"),
 * während Retell sie zusammengeschrieben liefert ("+491792340447").
 * Wir probieren alle gängigen Varianten durch.
 */
function buildPhoneVariants(input) {
  if (!input) return [];
  const clean = String(input).replace(/[\s\-\(\)\.\/]/g, '');

  // E.164-Normalform ohne Leerzeichen
  let e164;
  if (clean.startsWith('+'))         e164 = clean;
  else if (clean.startsWith('00'))   e164 = '+' + clean.slice(2);
  else if (clean.startsWith('0'))    e164 = '+49' + clean.slice(1);
  else                                e164 = '+' + clean;

  const digits = e164.slice(1); // nur Ziffern, ohne +
  if (digits.length < 6) return [e164];

  const variants = new Set();
  variants.add(e164);                            // +491792340447
  variants.add(digits);                          // 491792340447 (ohne +)
  variants.add('0' + digits.slice(2));           // 01792340447 (deutsche Schreibweise)

  // Varianten mit typischen Trennzeichen (für deutsche Nummern)
  if (digits.startsWith('49') && digits.length >= 5) {
    const cc   = digits.slice(0, 2);   // 49
    const area = digits.slice(2, 5);   // 179
    const rest = digits.slice(5);      // 2340447

    variants.add(`+${cc} ${area} ${rest}`);   // +49 179 2340447  ← HubSpot-Default
    variants.add(`+${cc} ${area}${rest}`);    // +49 1792340447
    variants.add(`0${area} ${rest}`);         // 0179 2340447
    variants.add(`+${cc}-${area}-${rest}`);   // +49-179-2340447
    variants.add(`(0${area}) ${rest}`);       // (0179) 2340447
  }

  return [...variants];
}

async function robustContactLookup({ phone, email }) {
  const variants = buildPhoneVariants(phone);
  const props = ['firstname','lastname','email','phone','mobilephone',
                 'hubspot_owner_id','em_ai_opt_out_ki_calls','em_ai_call_status'];

  // 1) Exakte Matches in allen Format-Varianten und beiden Telefonfeldern
  for (const variant of variants) {
    for (const field of ['phone', 'mobilephone']) {
      try {
        const r = await hs.post('/crm/v3/objects/contacts/search', {
          filterGroups: [{ filters: [{ propertyName: field, operator: 'EQ', value: variant }] }],
          properties: props,
          limit: 1
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

  // 2) Fuzzy-Fallback: Letzte 7 Ziffern (deutscher Nummern-Stamm)
  if (phone) {
    const digitsOnly = String(phone).replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 7) {
      const lastSeven = digitsOnly.slice(-7);
      for (const field of ['phone', 'mobilephone']) {
        try {
          const r = await hs.post('/crm/v3/objects/contacts/search', {
            filterGroups: [{ filters: [{ propertyName: field, operator: 'CONTAINS_TOKEN', value: lastSeven }] }],
            properties: props,
            limit: 1
          });
          if (r.data.results?.length > 0) {
            console.log(`[lookup_contact] Fuzzy match via ${field} CONTAINS "${lastSeven}"`);
            return r.data.results[0];
          }
        } catch {}
      }
    }
  }

  // 3) Email als allerletzte Möglichkeit
  if (email) {
    try {
      const r = await hs.post('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: props,
        limit: 1
      });
      if (r.data.results?.length > 0) {
        console.log(`[lookup_contact] Match via email="${email}"`);
        return r.data.results[0];
      }
    } catch {}
  }

  console.log(`[lookup_contact] No match for phone="${phone}" email="${email}"`);
  return null;
}

function isBusinessHours() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours() + now.getMinutes() / 60;
  return CONFIG.BUSINESS_HOURS.days.includes(day) &&
    hour >= CONFIG.BUSINESS_HOURS.start &&
    hour < CONFIG.BUSINESS_HOURS.end;
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
// F1: lookup_contact — Zu Beginn JEDES Gesprächs
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// F2: create_contact — Wenn Kontakt nicht gefunden
// ═══════════════════════════════════════════════════════════
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
// F3: get_deal_status — Lieferstatus / Bestellung (Stufe 3)
// ═══════════════════════════════════════════════════════════
app.post('/retell/get_deal_status', async (req, res) => {
  const { contact_id, order_number, verification_level } = req.body;
  if (parseInt(verification_level) < 3) return res.json({
    success: false,
    message: 'Verifikationsstufe 3 erforderlich. Ordernummer + Name erfragen.'
  });
  try {
    const filters = [];
    if (order_number) filters.push({ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: order_number });
    if (contact_id) filters.push({ propertyName: 'associations.contact', operator: 'EQ', value: contact_id });
    const r = await hs.post('/crm/v3/objects/deals/search', {
      filterGroups: [{ filters }],
      properties: ['dealname','dealstage','amount','expected_delivery_date','vehicle_brand','vehicle_model'],
      limit: 1
    });
    if (!r.data.results?.length) return res.json({ success: false, message: 'Kein Deal gefunden. Ticket + Rückruf anbieten.' });
    const p = r.data.results[0].properties;
    res.json({
      success: true, deal_id: r.data.results[0].id,
      dealname: p.dealname, stage: p.dealstage,
      vehicle: `${p.vehicle_brand||''} ${p.vehicle_model||''}`.trim(),
      expected_delivery: p.expected_delivery_date || 'Noch nicht bestätigt',
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// F4: add_call_note — PFLICHT nach JEDEM Gespräch
// ═══════════════════════════════════════════════════════════
app.post('/retell/add_call_note', async (req, res) => {
  const { contact_id, deal_id, category, intent, summary,
          next_step, open_points, verification_level,
          channel, special_case, callback_time } = req.body;
  const body = [
    `[KI-Notiz ${new Date().toLocaleString('de-DE')}]`,
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

// ═══════════════════════════════════════════════════════════
// F5: create_task — Aufgabe für Team
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// F6: book_appointment — Termin / Rückruf
// ═══════════════════════════════════════════════════════════
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
// F8: lookup_tickets_for_dedupe — VOR create_ticket aufrufen
// ═══════════════════════════════════════════════════════════
app.post('/retell/lookup_tickets_for_dedupe', async (req, res) => {
  const { contact_id, pipeline } = req.body;
  try {
    const r = await hs.post('/crm/v3/objects/tickets/search', {
      filterGroups: [{ filters: [
        { propertyName: 'associations.contact', operator: 'EQ', value: contact_id },
        { propertyName: 'hs_pipeline', operator: 'EQ', value: pipeline },
        { propertyName: 'hs_ticket_status', operator: 'NEQ', value: 'CLOSED' },
      ]}],
      properties: ['subject','hs_pipeline_stage','createdate'], limit: 3
    });
    if (!r.data.results?.length) return res.json({ duplicate_found: false });
    const t = r.data.results[0];
    res.json({ duplicate_found: true, existing_ticket_id: t.id, subject: t.properties.subject });
  } catch (e) { res.json({ duplicate_found: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// F9: check_business_hours
// ═══════════════════════════════════════════════════════════
app.post('/retell/check_business_hours', (req, res) => {
  const open = isBusinessHours();
  res.json({
    is_open: open,
    message: open ? 'Geschäftszeiten aktiv — Transfer möglich.' : 'Außerhalb GZ — Rückruf anbieten.',
    recommendation: open ? 'transfer_to_human aufrufen' : 'create_task + book_appointment'
  });
});

// ═══════════════════════════════════════════════════════════
// F10: set_opt_out
// ═══════════════════════════════════════════════════════════
app.post('/retell/set_opt_out', async (req, res) => {
  const { contact_id } = req.body;
  try {
    await hs.patch(`/crm/v3/objects/contacts/${contact_id}`, { properties: {
      em_ai_opt_out_ki_calls: 'true', em_ai_call_status: 'optout'
    }});
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// F11: transfer_to_human — Gespräch an Mensch übergeben
// ═══════════════════════════════════════════════════════════
app.post('/retell/transfer_to_human', async (req, res) => {
  const { contact_id, reason, urgency } = req.body;
  const transferNumber = process.env.INTERNAL_TRANSFER_NUMBER;

  if (!transferNumber) {
    console.log('[Transfer] FEHLER: Keine INTERNAL_TRANSFER_NUMBER in Env-Variables gesetzt.');
    return res.json({
      success: false,
      transfer_possible: false,
      message: 'Keine Transfer-Nummer konfiguriert. Bitte Rückruf-Task anlegen.',
      fallback: 'create_task'
    });
  }

  const open = isBusinessHours();
  if (!open) {
    return res.json({
      success: false,
      transfer_possible: false,
      message: 'Außerhalb der Geschäftszeiten. Bitte Rückruf für den nächsten Werktag vereinbaren.',
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
    } catch (e) {
      console.log(`[Transfer] HubSpot-Update fehlgeschlagen: ${e.message}`);
    }
  }

  console.log(`[Transfer] Contact ${contact_id||'unbekannt'} → ${transferNumber} | Grund: ${reason||'k.A.'} | Dringlichkeit: ${urgency||'normal'}`);

  res.json({
    success: true,
    transfer_possible: true,
    transfer_number: transferNumber,
    message: 'Ich verbinde Sie jetzt mit einem Kollegen aus dem Team.'
  });
});

// ═══════════════════════════════════════════════════════════
// POST-CALL WEBHOOK
// ═══════════════════════════════════════════════════════════
app.post('/retell/post-call-webhook', async (req, res) => {
  console.log(`[Post-Call] ${req.body.call_id} — Status: ${req.body.call_status}`);
  res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', functions: 11, version: 'v2' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Retell Integration v2 läuft auf Port ${PORT}`));
