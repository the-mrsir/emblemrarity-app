#!/usr/bin/env node

import axios from "axios";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function checkHealth() {
  console.log("🔍 Checking server health...");
  
  try {
    const response = await axios.get(`${BASE_URL}/health`, { timeout: 10000 });
    console.log("✅ Basic health check:", response.data);
  } catch (error) {
    console.error("❌ Basic health check failed:", error.message);
    return false;
  }
  
  return true;
}

async function checkDetailedHealth() {
  console.log("\n🔍 Checking detailed server health...");
  
  try {
    const response = await axios.get(`${BASE_URL}/health/detailed`, { timeout: 15000 });
    console.log("✅ Detailed health check:");
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Detailed health check failed:", error.message);
  }
}

async function checkSyncStatus() {
  console.log("\n🔍 Checking sync status...");
  
  try {
    const response = await axios.get(`${BASE_URL}/api/sync/status`, { timeout: 10000 });
    console.log("✅ Sync status:", response.data);
  } catch (error) {
    console.error("❌ Sync status check failed:", error.message);
  }
}

async function checkSyncProgress() {
  console.log("\n🔍 Checking sync progress...");
  
  try {
    const response = await axios.get(`${BASE_URL}/api/sync/progress`, { timeout: 10000 });
    console.log("✅ Sync progress:", response.data);
  } catch (error) {
    console.error("❌ Sync progress check failed:", error.message);
  }
}

async function testConnection() {
  console.log("\n🔍 Testing basic connection...");
  
  try {
    const start = Date.now();
    const response = await axios.get(`${BASE_URL}/`, { timeout: 10000 });
    const duration = Date.now() - start;
    
    console.log(`✅ Connection successful (${duration}ms)`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Content-Type: ${response.headers['content-type']}`);
  } catch (error) {
    console.error("❌ Connection test failed:", error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error("   Server is not running or not accessible");
    } else if (error.code === 'ETIMEDOUT') {
      console.error("   Request timed out - server may be overloaded");
    } else if (error.code === 'ENOTFOUND') {
      console.error("   Host not found - check your BASE_URL");
    }
  }
}

async function checkRailwayStatus() {
  console.log("\n🔍 Railway-specific checks...");
  
  try {
    // Check if we're running in Railway
    const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID;
    console.log(`   Railway Environment: ${isRailway ? 'Yes' : 'No'}`);
    
    if (isRailway) {
      console.log(`   Project ID: ${process.env.RAILWAY_PROJECT_ID || 'Unknown'}`);
      console.log(`   Service ID: ${process.env.RAILWAY_SERVICE_ID || 'Unknown'}`);
      console.log(`   Environment: ${process.env.RAILWAY_ENVIRONMENT || 'Unknown'}`);
    }
    
    // Check volume mount
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    console.log(`   Volume Mount: ${volumePath || 'None'}`);
    
    if (volumePath) {
      try {
        const fs = await import('fs');
        const stats = fs.statSync(volumePath);
        console.log(`   Volume Access: ✅ Readable (${Math.round(stats.size / 1024 / 1024)}MB)`);
      } catch (e) {
        console.log(`   Volume Access: ❌ ${e.message}`);
      }
    }
    
  } catch (error) {
    console.error("❌ Railway status check failed:", error.message);
  }
}

async function main() {
  console.log("🚀 Emblem Rarity App Debug Tool");
  console.log("=" * 50);
  
  const basicHealth = await checkHealth();
  
  if (basicHealth) {
    await checkDetailedHealth();
    await checkSyncStatus();
    await checkSyncProgress();
  }
  
  await testConnection();
  await checkRailwayStatus();
  
  console.log("\n📋 Debug Summary:");
  console.log("1. Check Railway logs for any error messages");
  console.log("2. Verify your environment variables are set correctly");
  console.log("3. Check if the server is running and accessible");
  console.log("4. Monitor memory usage and database connections");
  console.log("5. Check if any sync operations are stuck");
  
  console.log("\n🔗 Useful URLs:");
  console.log(`   Health: ${BASE_URL}/health`);
  console.log(`   Detailed Health: ${BASE_URL}/health/detailed`);
  console.log(`   Sync Status: ${BASE_URL}/api/sync/status`);
  console.log(`   Admin Panel: ${BASE_URL}/admin/ui.html`);
}

main().catch(console.error);
