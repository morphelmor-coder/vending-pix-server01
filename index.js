require('dotenv').config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const fs = require("fs");

const app = express();
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const CLIENT_ID = process.env.EFI_CLIENT_ID;
const CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;
const CERT_BASE64 = process.env.EFI_CERTIFICADO_BASE64;

// ⚠️ URL CORRETA - Este é o ponto mais importante!
const EFI_API_URL = "https://pix.api.efipay.com.br";

let httpsAgent = null;

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

let tokenCache = { value: null, expiresAt: 0 };

// ==================== TOKEN ====================
async function getToken() {
    if (tokenCache.value && tokenCache.expiresAt > Date.now() + 300000) {
        return tokenCache.value;
    }
    
    if (!httpsAgent) return null;
    
    try {
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
        
        // Usando a URL CORRETA
        const response = await axios.post(
            `${EFI_API_URL}/oauth/token`,
            { grant_type: "client_credentials" },
            {
                httpsAgent: httpsAgent,
                headers: {
                    "Authorization": `Basic ${credentials}`,
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );
        
        tokenCache.value = response.data.access_token;
        tokenCache.expiresAt = Date.now() + 6900000;
        console.log("✅ Token obtido com sucesso!");
        return tokenCache.value;
        
    } catch (error) {
        console.error("❌ Erro no token:", error.response?.data || error.message);
        return null;
    }
}

// ==================== CONSULTAR PIX ====================
async function consultarPix() {
    const token = await getToken();
    if (!token) return;
    
    try {
        const agora = new Date();
        const inicio = new Date(agora.getTime() - 300000);
        
        const response = await axios.get(
            `${EFI_API_URL}/v2/pix?inicio=${inicio.toISOString()}&fim=${agora.toISOString()}`,
            {
                httpsAgent: httpsAgent,
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 30000
            }
        );
        
        const pixList = response.data.pix || [];
        if (pixList.length > 0) {
            console.log(`💰 ${pixList.length} PIX encontrado(s)!`);
            // Aqui você adiciona a lógica para cada PIX
        } else {
            console.log(`🔍 Nenhum PIX novo.`);
        }
    } catch (error) {
        console.error("❌ Erro na consulta:", error.response?.data || error.message);
    }
}

// ==================== ENDPOINTS ====================
app.get("/", (req, res) => {
    res.json({
        status: "online",
        servidor: "PIX ESP32",
        api_url: EFI_API_URL,
        endpoints: ["/consultar", "/status", "/health"]
    });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/status", (req, res) => {
    res.json({
        status: "online",
        api_url: EFI_API_URL,
        token_valido: tokenCache.value ? "sim" : "não"
    });
});
app.get("/consultar", (req, res) => {
    res.json({ valor: 0, maquina: req.query.maquina, timestamp: Date.now() });
});

// ==================== INÍCIO ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🔗 API Efí: ${EFI_API_URL}`);
    
    setTimeout(async () => {
        const token = await getToken();
        if (token) {
            console.log("🎯 Conexão com Efí estabelecida!");
            setInterval(() => consultarPix(), 10000);
        } else {
            console.log("⚠️ Falha na conexão com Efí.");
        }
    }, 2000);
});