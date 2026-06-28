/**
 * authorityService.js
 *
 * Uses Gemini AI to determine the correct government authority for a reported
 * civic issue based on:
 *   - Issue category (from image analysis)
 *   - Precise GPS location (reverse-geocoded to a real address via Nominatim)
 *   - AI description of the problem
 *
 * Flow:
 *   1. Reverse-geocode lat/lng → human-readable address (city, district, state)
 *   2. Ask Gemini: "Given this category + address, which government department
 *      is responsible and what is their official contact?"
 *   3. If Gemini returns a confident, well-formed result → use it (source: 'ai')
 *   4. Otherwise fall back to static category map (source: 'static')
 */

const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ── Reverse geocoding ─────────────────────────────────────────────────────────

const reverseGeocode = async (latitude, longitude) => {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&addressdetails=1`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'CivicPulse/1.0 (civic-issue-reporting)' }
    });

    const addr = res.data?.address || {};
    const display = res.data?.display_name || '';

    return {
      display,                                                          // full readable address
      city:     addr.city || addr.town || addr.village || addr.county || '',
      district: addr.county || addr.state_district || '',
      state:    addr.state || '',
      country:  addr.country || 'India',
      pincode:  addr.postcode || ''
    };
  } catch (err) {
    console.warn('[authorityService] Nominatim failed:', err.message);
    return null;
  }
};

// ── AI authority resolution ───────────────────────────────────────────────────

const CATEGORY_TO_DEPT_HINT = {
  road_damage:            'Public Works Department (PWD) or Municipal Roads Division',
  water_supply:           'Water Supply Board or Jal Board',
  electricity:            'State Electricity Distribution Company (DISCOM/ESCOM/WBSEDCL etc.)',
  sanitation:             'Sanitation or Solid Waste Management Department',
  garbage:                'Solid Waste Management (SWM) or Municipal Sanitation Wing',
  street_light:           'Street Lighting / Electrical Department of the Municipal Corporation',
  drainage:               'Drainage / Storm Water Department of the Municipal Corporation',
  parks_recreation:       'Parks & Gardens Department of the Municipal Corporation',
  public_property_damage: 'Municipal Engineering or Estate Department',
  noise_pollution:        'State Pollution Control Board or Environment Department',
  encroachment:           'Town Planning / Enforcement Wing or Anti-Encroachment Cell',
  traffic:                'City Traffic Police',
  other:                  'General Administration or Municipal Corporation helpdesk'
};

/**
 * Ask Gemini to identify the responsible government authority.
 *
 * @param {string} category       - AI-detected issue category
 * @param {string} aiDescription  - AI-generated description of the issue
 * @param {object} geocode        - Result from reverseGeocode()
 * @returns {object|null}         - Authority object or null if AI fails
 */
const resolveAuthorityWithAI = async (category, aiDescription, geocode) => {
  try {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

    const deptHint = CATEGORY_TO_DEPT_HINT[category] || 'Municipal Corporation or relevant government department';
    const location = geocode
      ? `${geocode.city ? geocode.city + ', ' : ''}${geocode.district ? geocode.district + ', ' : ''}${geocode.state}, India (${geocode.display})`
      : 'India (exact location unknown)';

    const prompt = `You are an expert on Indian government administration and municipal bodies.

A civic issue has been reported at this location: ${location}

Issue details:
- Category: ${category.replace(/_/g, ' ')}
- Description: ${aiDescription}
- Department hint: ${deptHint}

Your task: Identify the EXACT government authority responsible for this issue at this specific location.

Rules:
1. Use the real name of the local municipal body (e.g., "BBMP" for Bengaluru, "BMC" for Mumbai, "MCD" for Delhi, "AMC" for Ahmedabad, "PMC" for Pune, "GHMC" for Hyderabad, "KMC" for Kolkata, "GCC" for Chennai, "NMC" for Nagpur etc.)
2. For electricity: use the actual DISCOM for that city/state (BESCOM, BSES, TSSPDCL, TANGEDCO, MSEDCL, etc.)
3. For traffic: use the actual city traffic police name
4. For pollution: use the actual State Pollution Control Board name
5. For water: use the actual water board name (BWSSB, DJB, HMWSSB, CMWSSB, etc.)
6. The email must be a plausible official government email (use real known domains like bbmp.gov.in, mcgm.gov.in, delhijalboard.nic.in etc. — if you know the real one use it, otherwise construct a plausible .gov.in address)
7. The phone must be the real helpline number if you know it, otherwise use "1916" (national municipal helpline) or relevant national helpline
8. department field: short acronym or label used for internal routing (e.g. "BBMP-Roads", "BESCOM", "Traffic Police")
9. If the location is a small town or village, use the district/state level authority

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "name": "<full official name of the responsible department/body>",
  "department": "<short department label for routing>",
  "email": "<official contact email>",
  "phone": "<helpline number>",
  "jurisdiction": "<city or district this authority covers>",
  "confidence": <0.0-1.0>
}`;

    const response = await axios.post(GEMINI_API_URL, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512, topP: 0.8 }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Empty Gemini response');

    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (!parsed.name || !parsed.email || !parsed.department) {
      throw new Error('Incomplete authority response from AI');
    }

    // Reject if confidence is very low
    if (typeof parsed.confidence === 'number' && parsed.confidence < 0.4) {
      throw new Error(`AI confidence too low: ${parsed.confidence}`);
    }

    console.log(`[authorityService] AI resolved: ${parsed.name} <${parsed.email}> (confidence: ${parsed.confidence})`);

    return {
      name:         parsed.name,
      department:   parsed.department,
      email:        parsed.email,
      phone:        parsed.phone || '1916',
      jurisdiction: parsed.jurisdiction || geocode?.city || '',
      source:       'ai',
      confidence:   parsed.confidence
    };
  } catch (err) {
    console.warn('[authorityService] AI resolution failed:', err.message);
    return null;
  }
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * resolveAuthority
 *
 * Resolves the responsible government authority for an issue using AI + location.
 *
 * @param {string} category        - AI-detected category
 * @param {string} aiDescription   - AI-generated description
 * @param {number} latitude
 * @param {number} longitude
 * @param {object} staticFallback  - From getStaticAuthority() — used only if AI fails
 * @returns {object}               - Authority with source: 'ai' | 'static'
 */
const resolveAuthority = async (category, aiDescription, latitude, longitude, staticFallback) => {
  // Step 1: Get human-readable location from coordinates
  const geocode = await reverseGeocode(latitude, longitude);
  if (geocode) {
    console.log(`[authorityService] Location: ${geocode.city}, ${geocode.state}`);
  }

  // Step 2: Ask AI for the correct authority
  const aiAuthority = await resolveAuthorityWithAI(category, aiDescription, geocode);
  if (aiAuthority) return aiAuthority;

  // Step 3: Static fallback — never fails
  console.log(`[authorityService] Using static fallback for category: ${category}`);
  return { ...staticFallback, source: 'static' };
};

module.exports = { resolveAuthority, reverseGeocode };
