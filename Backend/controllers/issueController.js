const Issue = require('../models/Issue');
const { analyzeIssueMedia } = require('../services/aiService');
const { sendIssueToAuthority } = require('../services/emailService');
const { resolveAuthority } = require('../services/authorityService');
const { getStaticAuthority } = require('../config/authorities');
const { awardPoints } = require('../services/gamificationService');

const DUPLICATE_RADIUS = parseInt(process.env.DUPLICATE_RADIUS_METERS) || 50;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/issues
//
// Full flow in ONE request:
//   1. Receive uploaded media (Cloudinary URLs via issueUpload middleware)
//   2. Receive GPS location (latitude, longitude, address)
//   3. AI analyzes media → category, title, description, severity
//   4. AI resolves authority from category + location → name, dept, email, phone
//   5. Duplicate check: same 50m radius AND same authority.department → reject
//   6. Create issue, email authority, award points
// ─────────────────────────────────────────────────────────────────────────────
const reportIssue = async (req, res) => {
  try {
    const { latitude, longitude, address, ward, city, state, pincode } = req.body;

    // ── Guards ────────────────────────────────────────────────────────────────
    if (!req.user.aadhaarVerified) {
      return res.status(403).json({
        success: false,
        message: 'Aadhaar verification is required to report issues.',
        code: 'AADHAAR_REQUIRED'
      });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one photo or video is required.' });
    }
    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'Location (GPS) is required.' });
    }

    // ── Step 1: Build media array from Cloudinary-uploaded files ─────────────
    const media = req.files.map(file => ({
      url: file.path,
      type: file.mimetype.startsWith('video/') ? 'video' : 'image',
      publicId: file.filename
    }));

    // ── Step 2: AI analyzes media + location context ──────────────────────────
    // Passes Cloudinary URLs — AI fetches images and returns:
    //   category, title, aiDescription, severity, confidence
    const locationContext = address || `${latitude}, ${longitude}`;
    const aiResult = await analyzeIssueMedia(media, locationContext);
    console.log(`[reportIssue] AI → category=${aiResult.category} severity=${aiResult.severity} confidence=${aiResult.confidence}`);

    // ── Step 3: AI resolves responsible authority from category + GPS ─────────
    // Gemini reverse-geocodes coords → real city/district, then identifies
    // the exact municipal department + official contact for that location.
    const staticFallback = getStaticAuthority(aiResult.category);
    const authority = await resolveAuthority(
      aiResult.category,
      aiResult.aiDescription || locationContext,
      parseFloat(latitude),
      parseFloat(longitude),
      staticFallback
    );
    console.log(`[reportIssue] Authority (${authority.source}): ${authority.name} | ${authority.department} | email=${authority.email} | emailSource=${authority.emailSource}`);
    if (authority.groundingSources?.length) {
      console.log(`[reportIssue] Grounding sources: ${authority.groundingSources.slice(0, 2).join(', ')}`);
    }

    // ── Step 4: Duplicate check — 50m radius + same authority department ──────
    // If BOTH conditions match → this issue is already filed → tell the user.
    // If location differs OR authority differs → it's a new issue.
    const duplicate = await Issue.findOne({
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(longitude), parseFloat(latitude)] },
          $maxDistance: DUPLICATE_RADIUS
        }
      },
      'assignedAuthority.department': authority.department,
      status: { $nin: ['resolved', 'rejected'] }
    }).select('issueId title category status assignedAuthority upvoteCount reportedAt media');

    if (duplicate) {
      return res.status(409).json({
        success: false,
        isDuplicate: true,
        message: `This issue has already been filed within ${DUPLICATE_RADIUS}m and is assigned to ${authority.department}. You can upvote it to increase priority.`,
        existingIssue: {
          issueId:    duplicate.issueId,
          title:      duplicate.title,
          category:   duplicate.category,
          status:     duplicate.status,
          department: duplicate.assignedAuthority?.department,
          authority:  duplicate.assignedAuthority?.name,
          upvoteCount:duplicate.upvoteCount,
          reportedAt: duplicate.reportedAt,
          thumbnail:  duplicate.media?.[0]?.url
        }
      });
    }

    // ── Step 5: Create issue ──────────────────────────────────────────────────
    const issue = await Issue.create({
      title:        aiResult.aiTitle || `${aiResult.category.replace(/_/g, ' ')} reported`,
      description:  aiResult.aiDescription || locationContext,
      category:     aiResult.category,
      aiCategory:   aiResult.category,
      aiDescription:aiResult.aiDescription,
      aiConfidence: aiResult.confidence,
      severity:     aiResult.severity || 'medium',
      reporterName: req.user.name,
      reporterId:   req.user._id,
      location: {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
        address: address || `${latitude}, ${longitude}`,
        ward, city, state, pincode
      },
      media,
      assignedAuthority: {
        name:            authority.name,
        department:      authority.department,
        email:           authority.email,
        phone:           authority.phone           || '',
        jurisdiction:    authority.jurisdiction    || '',
        website:         authority.website         || null,
        grievancePortal: authority.grievancePortal || null,
        emailSource:     authority.emailSource     || 'none',
        source:          authority.source,
        groundingSources:authority.groundingSources|| [],
        notes:           authority.notes           || ''
      },
      updates: [{
        message: `Issue reported by ${req.user.name}. ` +
                 `AI detected: "${aiResult.category}" (confidence ${Math.round((aiResult.confidence || 0) * 100)}%). ` +
                 `Assigned to ${authority.name} via ${authority.source} resolution.`,
        author:     'CivicPulse AI',
        authorType: 'ai'
      }]
    });

    // ── Step 6: Email the authority ───────────────────────────────────────────
    try {
      await sendIssueToAuthority(issue, authority.email);
    } catch (emailErr) {
      console.error('[reportIssue] Email failed (non-fatal):', emailErr.message);
    }

    // ── Step 7: Gamification points ───────────────────────────────────────────
    await awardPoints(req.user._id, 'report_issue');

    return res.status(201).json({
      success: true,
      message: 'Issue reported successfully!',
      issue: {
        issueId:      issue.issueId,
        title:        issue.title,
        category:     issue.category,
        status:       issue.status,
        severity:     issue.severity,
        aiDescription:issue.aiDescription,
        location: {
          address:    issue.location.address,
          latitude:   issue.location.coordinates[1],
          longitude:  issue.location.coordinates[0]
        },
        media: issue.media.map(m => ({ url: m.url, type: m.type })),
        reportedAt: issue.reportedAt,
        assignedAuthority: {
          name:            issue.assignedAuthority.name,
          department:      issue.assignedAuthority.department,
          phone:           issue.assignedAuthority.phone,
          jurisdiction:    issue.assignedAuthority.jurisdiction,
          website:         issue.assignedAuthority.website,
          grievancePortal: issue.assignedAuthority.grievancePortal,
          emailSource:     issue.assignedAuthority.emailSource,
          source:          issue.assignedAuthority.source,
          notes:           issue.assignedAuthority.notes
          // email intentionally omitted from response
        }
      }
    });

  } catch (error) {
    console.error('[reportIssue] Error:', error);
    res.status(500).json({ success: false, message: 'Failed to report issue. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/issues/stats/summary
// ─────────────────────────────────────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [total, resolved, inProgress, reported, categories] = await Promise.all([
      Issue.countDocuments(),
      Issue.countDocuments({ status: 'resolved' }),
      Issue.countDocuments({ status: 'in_progress' }),
      Issue.countDocuments({ status: 'reported' }),
      Issue.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ])
    ]);
    res.json({
      success: true,
      stats: {
        total, resolved, inProgress, reported,
        resolutionRate: total > 0 ? Math.round((resolved / total) * 100) : 0
      },
      categories
    });
  } catch (error) {
    console.error('[getStats] Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/issues
// ─────────────────────────────────────────────────────────────────────────────
const getIssues = async (req, res) => {
  try {
    const {
      page = 1, limit = 12, status, category, severity,
      latitude, longitude, radius = 5000, sort = '-reportedAt', search
    } = req.query;

    const query = {};
    if (status)   query.status = status;
    if (category) query.category = category;
    if (severity) query.severity = severity;
    if (search) {
      query.$or = [
        { title:       { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { issueId:     { $regex: search, $options: 'i' } }
      ];
    }
    if (latitude && longitude) {
      query.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(longitude), parseFloat(latitude)] },
          $maxDistance: parseInt(radius)
        }
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [issues, total] = await Promise.all([
      Issue.find(query)
        .select('-reporterId -assignedAuthority.email -updates.emailMessageId')
        .sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      Issue.countDocuments(query)
    ]);

    res.json({
      success: true, issues,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error('[getIssues] Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch issues.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/issues/:issueId
// ─────────────────────────────────────────────────────────────────────────────
const getIssue = async (req, res) => {
  try {
    const issue = await Issue.findOne({ issueId: req.params.issueId })
      .select('-assignedAuthority.email -updates.emailMessageId').lean();
    if (!issue) return res.status(404).json({ success: false, message: 'Issue not found.' });
    res.json({ success: true, issue });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch issue.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/issues/:issueId/upvote
// ─────────────────────────────────────────────────────────────────────────────
const upvoteIssue = async (req, res) => {
  try {
    const issue = await Issue.findOne({ issueId: req.params.issueId });
    if (!issue) return res.status(404).json({ success: false, message: 'Issue not found.' });

    const userId = req.user._id;
    const hasUpvoted = issue.upvotes.includes(userId);
    if (hasUpvoted) {
      issue.upvotes.pull(userId);
      issue.upvoteCount = Math.max(0, issue.upvoteCount - 1);
    } else {
      issue.upvotes.push(userId);
      issue.upvoteCount += 1;
    }
    await issue.save();
    res.json({ success: true, upvoted: !hasUpvoted, upvoteCount: issue.upvoteCount });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to upvote.' });
  }
};

module.exports = { reportIssue, getIssues, getIssue, upvoteIssue, getStats };
