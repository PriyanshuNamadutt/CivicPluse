const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const updateSchema = new mongoose.Schema({
  message: { type: String, required: true },
  author: String,
  authorType: { type: String, enum: ['citizen', 'authority', 'system', 'ai'] },
  media: [{
    url: String,
    type: { type: String, enum: ['image', 'video'] },
    publicId: String
  }],
  isResolutionProof: { type: Boolean, default: false },
  aiVerified: { type: Boolean, default: false },
  aiVerificationNote: String,
  emailMessageId: String, // for tracking email thread
  createdAt: { type: Date, default: Date.now }
});

const issueSchema = new mongoose.Schema({
  issueId: {
    type: String,
    unique: true,
    default: () => 'CP-' + Date.now().toString(36).toUpperCase() + '-' + uuidv4().split('-')[0].toUpperCase()
  },
  title: { type: String, required: true, maxlength: 200 },
  description: { type: String, required: true, maxlength: 2000 },
  // AI categorization
  category: {
    type: String,
    enum: ['road_damage', 'water_supply', 'electricity', 'sanitation', 'garbage',
      'street_light', 'drainage', 'parks_recreation', 'public_property_damage',
      'noise_pollution', 'encroachment', 'traffic', 'other'],
    required: true
  },
  aiCategory: String,
  aiDescription: String,
  aiConfidence: Number,
  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  // Reporter info (public display names, sensitive hidden)
  reporterName: { type: String, required: true },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Location
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: { type: [Number], required: true }, // [longitude, latitude]
    address: String,
    ward: String,
    city: String,
    state: String,
    pincode: String
  },
  // Media
  media: [{
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    publicId: String,
    thumbnail: String
  }],
  // Authority
  assignedAuthority: {
    name: String,
    email: { type: String, required: true },
    department: String
  },
  authorityEmailThreadId: String, // email Message-ID for threading
  // Status tracking
  status: {
    type: String,
    enum: ['reported', 'acknowledged', 'in_progress', 'resolved', 'rejected', 'duplicate'],
    default: 'reported'
  },
  resolutionProofUrl: String,
  resolutionProofType: String,
  resolvedAt: Date,
  // Duplicate check
  duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Issue' },
  upvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  upvoteCount: { type: Number, default: 0 },
  // Updates timeline
  updates: [updateSchema],
  // Timestamps
  reportedAt: { type: Date, default: Date.now },
  acknowledgedAt: Date,
  estimatedResolution: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Geospatial index for proximity search
issueSchema.index({ location: '2dsphere' });
issueSchema.index({ issueId: 1 });
issueSchema.index({ status: 1 });
issueSchema.index({ category: 1 });
issueSchema.index({ reportedAt: -1 });

issueSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Issue', issueSchema);
