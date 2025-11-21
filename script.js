/* -------- Firebase setup -------- */
const firebaseConfig = {
  apiKey: "AIzaSyBBZxCwywnv_ZVXYezOV8IKG6iKWK5sL10",
  authDomain: "studio-ywlo1.firebaseapp.com",
  projectId: "studio-ywlo1",
  storageBucket: "studio-ywlo1.firebasestorage.app",
  messagingSenderId: "791958850921",
  appId: "1:791958850921:web:149be668e7f132e59f41f8"
};
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
const rtdb = firebase.database();

/* -------- Globals -------- */
const ROOM_ID = "global-room";
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let localStream = null;
let peers = new Map();
let presenceRef = null;
let peersRef = null;
let ourUid = null;

/* -------- UI helpers -------- */
function showRegister() {
  document.getElementById("login-section").classList.add("hidden");
  document.getElementById("register-section").classList.remove("hidden");
}
function showLogin() {
  document.getElementById("register-section").classList.add("hidden");
  document.getElementById("login-section").classList.remove("hidden");
}
function gridEl() { return document.getElementById("video-grid"); }
function selfViewWrap() { return document.getElementById("self-view"); }
function selfViewVideo() { return document.querySelector("#self-view video"); }
function fullscreenWrap() { return document.getElementById("fullscreen"); }
function fullscreenVideo() { return document.getElementById("fullscreen-video"); }

function ensureTile(uid, label) {
  const grid = gridEl();
  let tile = grid.querySelector(`[data-uid="${uid}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-box";
    tile.dataset.uid = uid;
    tile.innerHTML = `<strong class="name">${label || uid}</strong><video autoplay playsinline muted></video>`;
    tile.onclick = () => openFullscreen(tile.querySelector("video"));
    grid.appendChild(tile);
  }
  return tile;
}
function removeTile(uid) {
  const tile = gridEl().querySelector(`[data-uid="${uid}"]`);
  if (tile) tile.remove();
}
function openFullscreen(videoEl) {
  if (videoEl?.srcObject) {
    fullscreenVideo().srcObject = videoEl.srcObject;
    fullscreenWrap().classList.remove("hidden");
  }
}
function closeFullscreen() {
  fullscreenWrap().classList.add("hidden");
}
window.closeFullscreen = closeFullscreen;

/* -------- Auth: Register/Login -------- */
document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const firstName = document.getElementById("firstName").value.trim();
  const lastName = document.getElementById("lastName").value.trim();
  const email = document.getElementById("email").value.trim();
  const country = document.getElementById("country").value;
  const gender = document.getElementById("gender").value;
  const phone = document.getElementById("phone").value.trim();
  const password = document.getElementById("password").value;

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await db.collection("users").doc(uid).set({ firstName, lastName, email, country, gender, phone });
    alert("Registration successful!");
    document.getElementById("register-section").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
  } catch (err) {
    alert("Registration failed: " + err.message);
  }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  try {
    await auth.signInWithEmailAndPassword(email, password);
    alert("Login successful!");
  } catch (err) {
    alert("Login failed: " + err.message);
  }
});

async function logout() {
  await auth.signOut();
  closeFullscreen();
  hideLiveSection();
  showLogin();
}
window.logout = logout;

auth.onAuthStateChanged(user => {
  if (user) {
    document.getElementById("login-section").classList.add("hidden");
    document.getElementById("register-section").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
  } else {
    document.getElementById("dashboard").classList.add("hidden");
    document.getElementById("register-section").classList.add("hidden");
    document.getElementById("login-section").classList.remove("hidden");
  }
});

/* -------- Live section -------- */
function pairKey(a, b) {
  return [a, b].sort().join("_");
}

async function showLiveSection() {
  const user = auth.currentUser;
  if (!user) {
    alert("Lowani kaye musanayambe live video.");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    selfViewVideo().srcObject = localStream;
    selfViewWrap().classList.remove("hidden");
  } catch (e) {
    alert("Camera/Audio yalakwika: " + e.message);
    return;
  }

  ourUid = user.uid;

  let label = user.email;
  try {
    const doc = await db.collection("users").doc(ourUid).get();
    if (doc.exists) {
      const d = doc.data();
      const n = `${(d.firstName || "").trim()} ${(d.lastName || "").trim()}`.trim();
      label = n || d.email || user.email;
    }
  } catch {}

  presenceRef = rtdb.ref(`live/${ROOM_ID}/peers/${ourUid}`);
  await presenceRef.set({ uid: ourUid, label, joinedAt: Date.now() });
  presenceRef.onDisconnect().remove();

  peersRef = rtdb.ref(`live/${ROOM_ID}/peers`);
  peersRef.on("value", async (snap) => {
    const peersData = snap.val() || {};
    const uids = Object.keys(peersData);

    gridEl().innerHTML = "";
    for (const uid of uids) {
      const tl = ensureTile(uid, peersData[uid]?.label || uid);
      const v = tl.querySelector("video");
      if (uid === ourUid) {
        v.srcObject = localStream;
        v.muted = true;
      } else {
        if (!peers.has(uid)) await createConnectionToPeer(uid);
        const p = peers.get(uid);
        if (p?.stream) {
          v.srcObject = p.stream;
          v.muted = false;
        }
      }
    }
    for (const [uid] of peers) {
      if (!uids.includes(uid)) teardownPeer(uid);
    }
  });

  attachSignalListeners();

  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("video-section").classList.remove("hidden");
}
window.showLiveSection = showLiveSection;

async function hideLiveSection() {
  try { if (presenceRef) await presenceRef.remove(); } catch {}
  if (peersRef) peersRef.off();
  detachSignalListeners();

  for (const [uid] of peers) teardownPeer(uid);
  peers.clear();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  fullscreenWrap().classList.add("hidden");
  selfViewWrap().classList.add("hidden");
  gridEl().innerHTML = "";

  document.getElementById("video-section").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
}
window.hideLiveSection = hideLiveSection;

/* -------- WebRTC -------- */
async function createConnectionToPeer(remoteUid) {
  if (remoteUid === ourUid || peers.has(remoteUid)) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    let obj = peers.get(remoteUid) || { pc, stream: null };
    obj.stream = stream;
    peers.set(remoteUid, obj);

    const tile = ensureTile(remoteUid, remoteUid);
    tile.querySelector("video").srcObject = stream;
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const pk = pairKey(ourUid, remoteUid);
    rtdb.ref(`live/${ROOM_ID}/signals/${pk}/candidates/${ourUid}`).push(e.candidate);
  };

  peers.set(remoteUid, { pc, stream: null });

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    const pk = pairKey(ourUid, remoteUid);
    await rtdb.ref(`live/${ROOM_ID}/signals/${pk}/offers/${ourUid}`).set({
      sdp: offer.sdp,
      type: offer.type,
      ts: Date.now()
    });
  } catch (e) {
    console.error("Offer error:", e);
  }
}

/* -------- Skeleton for incoming offer -------- */
function createSkeleton(remoteUid) {
  if (remoteUid === ourUid || peers.has(remoteUid)) return peers.get(remoteUid);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    let obj = peers.get(remoteUid) || { pc, stream: null };
    obj.stream = stream;
    peers.set(remoteUid, obj);

    const tile = ensureTile(remoteUid, remoteUid);
    tile.querySelector("video").srcObject = stream;
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const pk = pairKey(ourUid, remoteUid);
    rtdb.ref(`live/${ROOM_ID}/signals/${pk}/candidates/${ourUid}`).push(e.candidate);
  };

  peers.set(remoteUid, { pc, stream: null });
  return peers.get(remoteUid);
}

/* -------- Teardown -------- */
function teardownPeer(remoteUid) {
  const p = peers.get(remoteUid);
  try { p?.pc?.close(); } catch {}
  peers.delete(remoteUid);
  removeTile(remoteUid);
}

/* -------- Signalling listeners -------- */
function attachSignalListeners() {
  const root = rtdb.ref(`live/${ROOM_ID}/signals`);
  root.on("value", snap => {
    const data = snap.val() || {};
    Object.keys(data).forEach(pk => {
      if (!pk.includes(auth.currentUser?.uid)) return;
      wirePair(pk);
    });
  });
}
function detachSignalListeners() {
  rtdb.ref(`live/${ROOM_ID}/signals`).off();
}

function wirePair(pk) {
  const offersRef = rtdb.ref(`live/${ROOM_ID}/signals/${pk}/offers`);
  offersRef.on("child_added", async child => {
    const fromUid = child.key;
    if (fromUid === ourUid) return;
    const offer = child.val();

    let p = peers.get(fromUid);
    if (!p) p = createSkeleton(fromUid);

    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      await rtdb.ref(`live/${ROOM_ID}/signals/${pk}/answers/${ourUid}`).set({
        sdp: answer.sdp,
        type: answer.type,
        ts: Date.now()
      });
    } catch (e) {
      console.error("Answer error:", e);
    }
  });

  const answersRef = rtdb.ref(`live/${ROOM_ID}/signals/${pk}/answers`);
  answersRef.on("child_added", async child => {
    const fromUid = child.key;
    if (fromUid === ourUid) return;
    const answer = child.val();
    const p = peers.get(fromUid);
    if (!p) return;
    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      console.error("Set remote answer error:", e);
    }
  });

  const candRef = rtdb.ref(`live/${ROOM_ID}/signals/${pk}/candidates`);
  candRef.on("child_added", userNode => {
    const uidNode = userNode.key;
    const userCandRef = rtdb.ref(`live/${ROOM_ID}/signals/${pk}/candidates/${uidNode}`);
    userCandRef.on("child_added", async candSnap => {
      const fromUid = uidNode;
      if (fromUid === ourUid) return;
      const candidate = candSnap.val();
      const p = peers.get(fromUid);
      if (!p) return;
      try {
        await p.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("Add ICE error:", e);
      }
    });
  });
}

/* -------- On load -------- */
window.addEventListener("load", () => {
  document.getElementById("login-section").classList.remove("hidden");
});

