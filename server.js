// ============================================================
//  SERVEUR DU CHAT PAR THÈMES
//  Lancer avec :  node server.js
// ============================================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Au bout de combien de temps (en millisecondes) on accepte
// de mettre quelqu'un avec une personne qui n'a pas le même thème.
const ATTENTE_AVANT_N_IMPORTE_QUI = 12000; // 12 secondes

// La file d'attente : toutes les personnes qui cherchent quelqu'un.
// Chaque entrée = { socket, themes, depuis }
let fileAttente = [];

// ----- Signalements et blocages -----
const NB_SIGNALEMENTS_POUR_BLOQUER = 3;  // nombre de personnes DIFFÉRENTES qui doivent signaler
const DUREE_BLOCAGE = 60 * 60 * 1000;    // blocage d'1 heure
const signalements = new Map();          // adresse IP signalée -> ensemble des IP qui l'ont signalée
const bloques = new Map();               // adresse IP -> heure de fin du blocage

function ipDe(socket) {
  // Derrière un hébergeur (Render...), la vraie adresse est à la fin de x-forwarded-for
  const h = socket.handshake.headers["x-forwarded-for"];
  if (h) return h.split(",").pop().trim();
  return socket.handshake.address;
}

function estBloque(ip) {
  const fin = bloques.get(ip);
  if (!fin) return false;
  if (Date.now() > fin) {
    bloques.delete(ip);
    signalements.delete(ip);
    return false;
  }
  return true;
}

function themesCommuns(a, b) {
  return a.themes.filter((t) => b.themes.includes(t));
}

function mettreEnRelation(a, b) {
  fileAttente = fileAttente.filter((p) => p !== a && p !== b);
  a.socket.partenaire = b.socket;
  b.socket.partenaire = a.socket;
  const communs = themesCommuns(a, b);
  a.socket.emit("trouve", { communs });
  b.socket.emit("trouve", { communs });
}

function chercherDesPaires() {
  const maintenant = Date.now();

  // ETAPE 1 : on associe en priorité les gens qui ont des thèmes en commun
  for (const a of [...fileAttente]) {
    if (!fileAttente.includes(a)) continue;
    let meilleur = null;
    let meilleurScore = 0;
    for (const b of fileAttente) {
      if (b === a) continue;
      const score = themesCommuns(a, b).length;
      if (score > meilleurScore) {
        meilleur = b;
        meilleurScore = score;
      }
    }
    if (meilleur) mettreEnRelation(a, meilleur);
  }

  // ETAPE 2 : ceux qui attendent depuis trop longtemps sont associés
  // avec n'importe qui d'autre dans la file
  for (const a of [...fileAttente]) {
    if (!fileAttente.includes(a)) continue;
    if (maintenant - a.depuis < ATTENTE_AVANT_N_IMPORTE_QUI) continue;
    const autre = fileAttente.find((b) => b !== a);
    if (autre) mettreEnRelation(a, autre);
  }
}

// On vérifie la file toutes les secondes
setInterval(chercherDesPaires, 1000);

function quitterConversation(socket) {
  fileAttente = fileAttente.filter((p) => p.socket !== socket);
  if (socket.partenaire) {
    socket.partenaire.emit("parti");
    socket.partenaire.partenaire = null;
    socket.partenaire = null;
  }
}

function envoyerNombreEnLigne() {
  io.emit("enligne", io.engine.clientsCount);
}

io.on("connection", (socket) => {
  socket.ip = ipDe(socket);
  envoyerNombreEnLigne();

  // La personne a coché ses thèmes et clique sur "Trouver quelqu'un"
  socket.on("chercher", (themes) => {
    if (estBloque(socket.ip)) {
      socket.emit("bloque");
      return;
    }
    quitterConversation(socket);
    if (!Array.isArray(themes) || themes.length === 0) return;
    const propres = themes.slice(0, 20).map((t) => String(t).slice(0, 30));
    fileAttente.push({ socket, themes: propres, depuis: Date.now() });
    chercherDesPaires();
  });

  // Un message à transmettre à l'autre personne
  socket.on("message", (texte) => {
    if (!socket.partenaire) return;
    const propre = String(texte).trim().slice(0, 500);
    if (propre) socket.partenaire.emit("message", propre);
  });

  // La personne arrête la discussion ou annule sa recherche
  socket.on("quitter", () => quitterConversation(socket));

  // La personne signale son interlocuteur
  socket.on("signaler", () => {
    const autre = socket.partenaire;
    if (!autre) return;
    const ipSignalee = autre.ip;
    if (!signalements.has(ipSignalee)) signalements.set(ipSignalee, new Set());
    signalements.get(ipSignalee).add(socket.ip);
    if (signalements.get(ipSignalee).size >= NB_SIGNALEMENTS_POUR_BLOQUER) {
      bloques.set(ipSignalee, Date.now() + DUREE_BLOCAGE);
    }
    console.log("[SIGNALEMENT]", new Date().toISOString(), "personne signalée :", ipSignalee,
                "| nombre de signalements :", signalements.get(ipSignalee).size);
    if (estBloque(ipSignalee)) autre.emit("bloque");
    socket.emit("signale");
    quitterConversation(socket);
  });

  socket.on("disconnect", () => {
    quitterConversation(socket);
    envoyerNombreEnLigne();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Le site tourne ici : http://localhost:" + PORT);
});
