// config/passport.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const UserRepository = require('../repositories/user.repository');
const config = require('./index');
const logger = require('./logger');

/**
 * Passport serialization
 * Determines which data of the user object should be stored in the session
 */
passport.serializeUser((user, done) => {
  done(null, user.id);
});

/**
 * Passport deserialization
 * Retrieves user object from database based on the session data
 */
passport.deserializeUser(async (id, done) => {
  try {
    const user = await UserRepository.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// ===============================
// Google OAuth Strategy (Placeholder)
// Only enabled if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are provided
// ===============================
if (config.GOOGLE_OAUTH_ENABLED) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: config.GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          // Check if user already exists with this googleId
          let user = await UserRepository.findByGoogleId(profile.id);
          
          if (user) {
            // User exists, return user
            return done(null, user);
          }
          
          // Check if user exists with same email (but different auth provider)
          user = await UserRepository.findByEmail(profile.emails[0].value);
          
          if (user && user.authProvider !== 'google') {
            // Email already registered with local provider – merge or error
            logger.warn(`Google OAuth: Email ${profile.emails[0].value} already registered with local auth`);
            return done(null, false, { message: 'Email already registered with password. Please login normally.' });
          }
          
          if (!user) {
            // Create new user with Google provider
            user = await UserRepository.create({
              fullName: profile.displayName,
              email: profile.emails[0].value,
              authProvider: 'google',
              googleId: profile.id,
              status: 'active', // Google users are pre-verified
              role: 'customer',
            });
            logger.info(`New user created via Google OAuth: ${user.email}`);
          }
          
          return done(null, user);
        } catch (error) {
          logger.error('Google OAuth error:', error);
          return done(error, null);
        }
      }
    )
  );
  logger.info('Google OAuth strategy initialized');
} else {
  logger.warn('Google OAuth not configured – skipping strategy');
}

module.exports = passport;