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

    if (sos_type === 'stop') {
      console.log(`🛑 Stopping SOS alert: ${sos_id}`);
      
      // Extract district and user info for stop notification
      const district = userInfo?.district;
      if (!district) {
        return res.status(400).json({ 
          error: 'Missing district in userInfo',
          message: 'district is required for stop notification'
        });
      }
      
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

    // Extract district from userInfo
    const district = userInfo?.district;
    if (!district) {
      return res.status(400).json({ 
        error: 'Missing district in userInfo',
        message: 'district is required for SOS alert'
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
