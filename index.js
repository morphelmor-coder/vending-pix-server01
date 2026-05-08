require('dotenv').config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const fs = require("fs");

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const CLIENT_ID = process.env.EFI_CLIENT_ID;
const CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;
const CERT_BASE64 = process.env.EFI_CERTIFICADO_BASE64;
const EFI_API_URL = "https://pix.api.efipay.com.br";

// ========== ESTADO DO SISTEMA ==========
let creditosPendentes = {};        // TXID -> valor pendente
let processedPix = new Set();       // Evita processar o mesmo PIX duas vezes
let tokenCache = { value: null, expiresAt: 0 };
let httpsAgent = null;

// ========== CONFIGURAÇÃO DO CERTIFICADO ==========
if (CERT_BASE64) {
    try {
        const tempCertPath = "/tmp/certificado.p12";
        const certBuffer = Buffer.from(CERT_BASE64, 'base64');
        fs.writeFileSync(tempCertPath, certBuffer);
        httpsAgent = new https.Agent({
            pfx: fs.readFileSync(tempCertPath),
            passphrase: "",
            rejectUnauthorized: true,
            minVersion: "TLSv1.2"
        });
        console.log("✅ Certificado configurado (TLS 1.2)");
    } catch (err) {
        console.error("❌ Erro no certificado:", err.message);
    }
}

// ========== TOKEN ==========
async function getToken() {
    if (tokenCache.value && tokenCache.expiresAt > Date.now() + 300000) {
        return tokenCache.value;
    }
    if (!httpsAgent) return null;
    try {
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
        const response = await axios.post(
            `${EFI_API_URL}/oauth/token`,
            { grant_type: "client_credentials" },
            {
                httpsAgent: httpsAgent,
                headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/json" },
                timeout: 30000
            }
        );
        tokenCache.value = response.data.access_token;
        tokenCache.expiresAt = Date.now() + 6900000;
        console.log("✅ Token obtido");
        return tokenCache.value;
    } catch (error) {
        console.error("❌ Erro token:", error.response?.data || error.message);
        return null;
    }
}

// ========== CONSULTAR PIX E ACUMULAR CRÉDITO ==========
async function consultarPix() {
    const token = await getToken();
    if (!token) return;
    try {
        const agora = new Date();
        const inicio = new Date(agora.getTime() - 10 * 60 * 1000); // 10 minutos atrás
        const response = await axios.get(
            `${EFI_API_URL}/v2/pix?inicio=${inicio.toISOString()}&fim=${agora.toISOString()}`,
            { httpsAgent: httpsAgent, headers: { "Authorization": `Bearer ${token}` }, timeout: 30000 }
        );
        const pixList = response.data.pix || [];
        if (pixList.length === 0) return;
        console.log(`💰 ${pixList.length} PIX encontrado(s)!`);
        for (const pix of pixList) {
            const endToEndId = pix.endToEndId;
            if (processedPix.has(endToEndId)) continue;
            processedPix.add(endToEndId);
            const txid = pix.txid || "SEM_TXID";
            const valor = Math.floor(parseFloat(pix.valor));
            console.log(`   PIX: ${txid} | R$ ${valor}`);
            // ACUMULA O CRÉDITO (independente do TXID, mas você pode filtrar)
            creditosPendentes[txid] = (creditosPendentes[txid] || 0) + valor;
            console.log(`   ✅ Crédito acumulado para ${txid}. Total pendente: R$ ${creditosPendentes[txid]}`);
        }
        if (processedPix.size > 1000) processedPix.clear();
    } catch (error) {
        console.error("❌ Erro PIX:", error.message);
    }
}

// ========== ENDPOINTS ==========
app.get("/", (req, res) => res.json({ status: "online", creditos_pendentes: creditosPendentes }));
app.get("/status", (req, res) => res.json({ token_valido: !!tokenCache.value, creditos_pendentes: creditosPendentes }));
app.get("/consultar", (req, res) => {
    const maquinaId = req.query.maquina;
    if (!maquinaId) return res.status(400).json({ error: "Parâmetro 'maquina' é obrigatório" });
    const credito = creditosPendentes[maquinaId] || 0;
    if (credito > 0) delete creditosPendentes[maquinaId];
    res.json({ valor: credito, maquina: maquinaId });
});
app.get("/debug", async (req, res) => {
    const token = await getToken();
    if (!token) return res.json({ erro: "Sem token" });
    try {
        const agora = new Date();
        const inicio = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
        const response = await axios.get(
            `${EFI_API_URL}/v2/pix?inicio=${inicio.toISOString()}&fim=${agora.toISOString()}`,
            { httpsAgent: httpsAgent, headers: { "Authorization": `Bearer ${token}` } }
        );
        res.json({ total: response.data.pix?.length || 0, transacoes: response.data.pix || [] });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// ========== INÍCIO ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Servidor na porta ${PORT}`);
    if (await getToken()) {
        console.log("✅ Autenticado. Iniciando polling...");
        setInterval(consultarPix, 10000);
        consultarPix();
    } else console.log("❌ Falha autenticação.");
});