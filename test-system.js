#!/usr/bin/env node

import axios from "axios";

const BASE_URL = process.env.BASE_URL || "https://emblemrarity.app";

async function testSystem() {
  console.log("🔍 Testing Emblem Rarity System v10.1.0");
  console.log("=" * 50);
  
  try {
    // Test 1: Basic health
    console.log("\n1️⃣ Testing basic health...");
    const health = await axios.get(`${BASE_URL}/health`);
    console.log("✅ Health:", health.data.ok ? "OK" : "FAILED");
    
    // Test 2: Sync status
    console.log("\n2️⃣ Testing sync status...");
    const syncStatus = await axios.get(`${BASE_URL}/api/sync/status`);
    console.log("✅ Sync Status:", syncStatus.data.sync_status);
    console.log("   Last Sync:", syncStatus.data.last_sync_date || "Never");
    console.log("   Should Sync Today:", syncStatus.data.should_sync_today);
    console.log("   Next Action:", syncStatus.data.next_action);
    console.log("   Message:", syncStatus.data.message);
    
    // Test 3: Progress
    console.log("\n3️⃣ Testing sync progress...");
    const progress = await axios.get(`${BASE_URL}/api/sync/progress`);
    console.log("✅ Progress:", progress.data.isRunning ? "Running" : "Not Running");
    if (progress.data.isRunning) {
      console.log("   Current:", progress.data.current);
      console.log("   Total:", progress.data.total);
      console.log("   Current Emblem:", progress.data.currentEmblem);
    }
    
    // Test 4: Rarity data
    console.log("\n4️⃣ Testing rarity data...");
    const rarity = await axios.get(`${BASE_URL}/api/rarity?hash=2939572589`);
    console.log("✅ Rarity Data:", rarity.data.percent ? `${rarity.data.percent}%` : "No data");
    console.log("   Source:", rarity.data.source);
    
    // Test 5: Detailed health
    console.log("\n5️⃣ Testing detailed health...");
    const detailed = await axios.get(`${BASE_URL}/health/detailed`);
    console.log("✅ Detailed Health:", detailed.data.ok ? "OK" : "FAILED");
    console.log("   Database Size:", Math.round(detailed.data.database.size / 1024), "KB");
    console.log("   Memory RSS:", detailed.data.memory.rss);
    console.log("   Active Tokens:", detailed.data.tokens.count);
    
    console.log("\n🎯 System Status Summary:");
    if (syncStatus.data.should_sync_today) {
      console.log("   ⚠️  SYNC NEEDED: Use admin panel to trigger daily sync");
    } else {
      console.log("   ✅  Data is current, no sync needed");
    }
    
    if (progress.data.isRunning) {
      console.log("   🔄  Sync is currently running");
    } else {
      console.log("   ⏸️  No sync currently running");
    }
    
    console.log("\n🔗 Admin Panel:", `${BASE_URL}/admin/ui.html`);
    console.log("   Health:", `${BASE_URL}/health`);
    console.log("   Sync Status:", `${BASE_URL}/api/sync/status`);
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    if (error.response) {
      console.error("   Status:", error.response.status);
      console.error("   Data:", error.response.data);
    }
  }
}

testSystem().catch(console.error);
