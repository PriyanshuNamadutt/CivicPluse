require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');

// Routes
const authRoutes = require('./routes/auth');
const issueRoutes = require('./routes/issues');
const userRoutes = require('./routes/users');

const app = express();

// Connect to MongoDB
connectDB();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

const isDev = process.env.NODE_ENV === 'development';

// General API rate limiter
// BUG FIX 1: In dev mode, set max to Infinity so no requests are ever blocked.
// BUG FIX 2: Added `skip` for auth routes so the general limiter does NOT
//            double-count /api/auth/* requests (it was silently blocking OTP
//            delivery by consuming the 100-req quota before authLimiter ran).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? Infinity : 100,
  skip: (req) => req.path.startsWith('/auth/'), // skip — authLimiter handles these
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Strict limiter for auth routes only
// BUG FIX 3: Was set to max:10000 (effectively unlimited but inconsistent).
//            Now clearly Infinity in dev, and a sane 10 in production to
//            prevent OTP/login brute-force without blocking legitimate sends.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? Infinity : 10,
  message: { success: false, message: 'Too many auth requests. Please wait 15 minutes.' }
});
app.use('/api/auth/', authLimiter);

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logger
if (isDev) {
  app.use(morgan('dev'));
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'CivicPulse API is running',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/issues', issueRoutes);
app.use('/api/users', userRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large. Max 50MB.' });
  }
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.'
  });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 CivicPulse Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔒 Rate limiting: ${isDev ? 'DISABLED (development)' : 'ENABLED (production)'}`);
});

// Start email monitoring (IMAP) after server starts
setTimeout(() => {
  try {
    const { startEmailMonitoring } = require('./services/imapService');
    startEmailMonitoring();
  } catch (err) {
    console.error('Email monitoring startup error:', err.message);
  }
}, 3000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => process.exit(0));
});

module.exports = app;
