const functions = require('firebase-functions');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK (no credentials needed in Cloud Functions)
admin.initializeApp();
console.log('✅ Firebase Admin SDK initialized successfully');

const DEFAULT_DISTRICT = 'unknown';
const REVERSE_GEOCODE_TIMEOUT_MS = 2500;
const REVERSE_GEOCODE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NOMINATIM_BASE_URL =
  process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT || 'sos-alerts/1.0 (firebase-functions)';
const reverseGeocodeCache = new Map();

function normalizeDistrictName(name) {
  if (!name || typeof name !== 'string') {
    return null;
  }

  const asciiOnly = name
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, '');

  const slug = asciiOnly
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return slug || null;
}

function pickDistrictFromAddress(address) {
  if (!address) {
    return null;
  }

  const districtLike =
    address.district ||
    address.state_district ||
    address.county ||
    address.city_district;
  const localityLike =
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.suburb;
  const stateLike = address.state || address.region;
  const countryLike = address.country;

  const directPick = normalizeDistrictName(districtLike || localityLike);
  if (directPick) {
    return directPick;
  }

  const statePick = normalizeDistrictName(stateLike);
  if (statePick) {
    return `${statePick}_general`;
  }

  const countryPick = normalizeDistrictName(countryLike);
  if (countryPick) {
    return `${countryPick}_general`;
  }

  return null;
}

async function reverseGeocodeDistrict(latitude, longitude) {
  const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < REVERSE_GEOCODE_CACHE_TTL_MS) {
    return { district: cached.district, source: 'cache' };
  }

  try {
    const url = new URL(NOMINATIM_BASE_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', latitude.toString());
    url.searchParams.set('lon', longitude.toString());
    url.searchParams.set('zoom', '10');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url, {
      headers: {
        'User-Agent': NOMINATIM_USER_AGENT,
        'Accept-Language': 'en'
      },
      signal: AbortSignal.timeout(REVERSE_GEOCODE_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Nominatim error: ${response.status}`);
    }

    const data = await response.json();
    const address = data?.address || null;
    const district = pickDistrictFromAddress(address);

    if (district) {
      if (reverseGeocodeCache.size > 1000) {
        reverseGeocodeCache.clear();
      }
      reverseGeocodeCache.set(cacheKey, { district, timestamp: Date.now() });
      return { district, source: 'nominatim' };
    }

    return { district: DEFAULT_DISTRICT, source: 'nominatim-fallback' };
  } catch (error) {
    console.error('❌ Reverse geocoding failed:', error.message);
    return { district: DEFAULT_DISTRICT, source: 'error' };
  }
}

// District discovery function based on coordinates (external reverse geocode)
async function getDistrictFromCoordinates(latitude, longitude) {
  const result = await reverseGeocodeDistrict(latitude, longitude);
  if (result.district === DEFAULT_DISTRICT) {
    console.warn(
      `⚠️ Falling back to default district for (${latitude}, ${longitude})`
    );
  }
  return result.district;
}

// Health check endpoint (unchanged)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: 'connected' // Always connected in CF
  });
});

// SOS Alert endpoint (unchanged, but removed firebaseInitialized check)
app.post('/api/sos', async (req, res) => {
  console.log('📡 SOS request received:', req.body);
  
  try {
    const { sos_id, sos_type, location, userInfo, timestamp, sender_id } = req.body;
    
    // Validate required fields
    if (!sos_id || !sos_type || !location) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['sos_id', 'sos_type', 'location']
      });
    }

    // Validate sos_type
    if (!['sos_alert', 'stop'].includes(sos_type)) {
      return res.status(400).json({ 
        error: 'Invalid sos_type',
        message: 'sos_type must be either "sos_alert" or "stop"'
      });
    }

    // Determine district from coordinates
    const district = await getDistrictFromCoordinates(location.latitude, location.longitude);
    
    if (sos_type === 'stop') {
      console.log(`🛑 Stopping SOS alert: ${sos_id}`);
      
      // Extract user info for stop notification
      const userName = userInfo?.name || 'Someone';
      const userLocation = userInfo?.location || district.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      // Send stop notification to all devices in the district
      const stopMessage = {
        topic: `district-${district}`,
        notification: {
          title: '✅ Emergency Resolved',
          body: `All good now. ${userName} • ${userLocation}.`
        },
        data: {
          type: 'sos_resolved',
          sos_id: sos_id,
          district: district,
          timestamp: timestamp || Date.now().toString(),
          sender_id: sender_id || 'unknown'
        },
        android: {
          notification: {
            icon: 'ic_notification',
            color: '#00FF00',
            sound: 'default',
            priority: 'high'
          }
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: '✅ Emergency Resolved',
                body: `Emergency situation in ${district.toUpperCase()} has been resolved`
              },
              sound: 'default',
              badge: 0
            }
          }
        }
      };

      // Send stop FCM message
      const stopResponse = await admin.messaging().send(stopMessage);
      
      console.log('✅ Stop notification sent successfully:', stopResponse);
      
      return res.json({ 
        success: true, 
        message: 'SOS alert stopped successfully',
        messageId: stopResponse,
        sosId: sos_id,
        district: district,
        timestamp: new Date().toISOString()
      });
    }

    console.log(`🚨 Sending SOS alert to district: ${district} (ID: ${sos_id})`);
    
    // Extract user info for notification
    const userName = userInfo?.name || 'Someone';
    const userLocation = userInfo?.location || district.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    // Prepare FCM message
    const message = {
      topic: `district-${district}`,
      notification: {
        title: '🚨 Emergency Alert',
        body: `Help needed. ${userName} • ${userLocation}`
      },
      data: {
        type: 'sos_alert',
        district: district,
        location: JSON.stringify(location),
        timestamp: timestamp || Date.now().toString(),
        userInfo: userInfo ? JSON.stringify(userInfo) : '{}',
        alertId: sos_id,
        sender_id: sender_id || 'unknown'
      },
      android: {
        notification: {
          icon: 'ic_notification',
          color: '#FF0000',
          sound: 'default',
          priority: 'high',
          defaultSound: true
        }
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: '🚨 Emergency Alert',
              body: `SOS alert in ${district.toUpperCase()} area`
            },
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    // Send FCM message
    const response = await admin.messaging().send(message);
    
    console.log('✅ SOS alert sent successfully:', response);
    
    res.json({ 
      success: true, 
      message: 'SOS alert sent successfully',
      messageId: response,
      topic: `district-${district}`,
      sosId: sos_id,
      district: district,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ SOS send error:', error);
    
    res.status(500).json({ 
      error: 'Failed to send SOS alert',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get district information from coordinates (unchanged)
app.post('/api/get-district', async (req, res) => {
  console.log('📍 District lookup request received:', req.body);
  
  try {
    const { latitude, longitude } = req.body;
    
    // Validate required fields
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['latitude', 'longitude']
      });
    }

    // Validate coordinates
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ 
        error: 'Invalid coordinate format',
        message: 'Latitude and longitude must be numbers'
      });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ 
        error: 'Invalid coordinate values',
        message: 'Latitude must be between -90 and 90, longitude between -180 and 180'
      });
    }

    // Get district from coordinates
    const district = await getDistrictFromCoordinates(latitude, longitude);
    
    console.log(`✅ District determined: ${district} for coordinates (${latitude}, ${longitude})`);
    
    res.json({ 
      success: true,
      district: district,
      fcm_topic: `district-${district}`,
      coordinates: {
        latitude: latitude,
        longitude: longitude
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ District lookup error:', error);
    
    res.status(500).json({ 
      error: 'Failed to determine district',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint to manually trigger SOS (for testing) (unchanged)
app.post('/api/test-sos', async (req, res) => {
  const testData = {
    sos_id: `test_sos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    sos_type: 'sos_alert',
    location: {
      latitude: 12.9716,
      longitude: 77.5946
    },
    userInfo: {
      deviceId: 'test-device',
      appVersion: '1.0.0'
    },
    timestamp: Date.now().toString()
  };
  
  // Forward to main SOS endpoint
  req.body = testData;
  return app._router.handle({ ...req, method: 'POST', url: '/api/sos' }, res);
});

// 404 handler (unchanged)
app.use((req, res) => {  // No path specified here—it's implied as catch-all
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /api/sos',
      'POST /api/get-district',
      'POST /api/test-sos'
    ]
  });
});

// Error handler (unchanged)
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message 
  });
});

// Export as Cloud Function (unchanged)
exports.api = functions.https.onRequest(app);
