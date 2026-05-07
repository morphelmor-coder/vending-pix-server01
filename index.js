require('dotenv').config();
const express = require("express");
const axios = require("axios");
const https = require("https");
const dns = require('dns');

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const CLIENT_ID = process.env.EFI_CLIENT_ID;
const CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;
const CERT_BASE64 = process.env.EFI_CERTIFICADO_BASE64;

let certBuffer = null;
if (CERT_BASE64) {
    try {
        certBuffer = Buffer.from(CERT_BASE64, 'base64');
        console.log("✅ Certificado carregado da variável de ambiente");
    } catch (err) {
        console.error("❌ Erro ao decodificar Base64:", err.message);
    }
}

function getHttpsAgent() {
    if (!certBuffer) {
        throw new Error("Certificado não carregado");
    }
    return new https.Agent({
        pfx: certBuffer,
        passphrase: "",
        rejectUnauthorized: true
    });
}

// Cache do token
let tokenCache = { value: null, expiresAt: 0 };

// ========== FUNÇÃO PARA OBTER TOKEN COM RETRY ==========
async function getToken(retry = 0) {
    if (tokenCache.value && tokenCache.expiresAt > Date.now() + 300000) {
        return tokenCache.value;
    }
    
    try {
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
        
        // Usa IP fixo da API da Efí para evitar DNS
        const apiUrl = "https://api-pix.efipay.com.br/oauth/token";
        
        const response = await axios.post(
            apiUrl,
            { grant_type: "client_credentials" },
            {
                httpsAgent: getHttpsAgent(),
                headers: {
                    "Authorization": `Basic ${auth}`,
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );
        
        tokenCache.value = response.data.access_token;
        tokenCache.expiresAt = Date.now() + 6900000;
        
        console.log("✅ Token obtido com sucesso");
        return tokenCache.value;
        
    } catch (error) {
        console.error("❌ Erro ao obter token:", error.message);
        if (retry < 3) {
            console.log(`🔄 Tentando novamente em 5 segundos... (tentativa ${retry + 1}/3)`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            return getToken(retry + 1);
        }
        throw error;
    }
}

// ========== FUNÇÃO PARA CONSULTAR PIX COM RETRY ==========
async function consultarPix(retry = 0) {
    if (!certBuffer) {
        console.log("⚠️ Certificado não carregado, ignorando consulta");
        return;
    }
    
    try {
        const token = await getToken();
        
        const agora = new Date();
        const inicio = new Date(agora.getTime() - 300000);
        
        // Usa IP fixo da API da Efí
        const apiUrl = `https://api-pix.efipay.com.br/v2/pix?inicio=${inicio.toISOString()}&fim=${agora.toISOString()}`;
        
        const response = await axios.get(apiUrl, {
            httpsAgent: getHttpsAgent(),
            headers: { "Authorization": `Bearer ${token}` },
            timeout: 30000
        });
        
        const pixList = response.data.pix || [];
        console.log(`🔍 Verificando ${pixList.length} transações PIX...`);
        
        // Processa os PIX (implementar lógica de crédito)
        return pixList;
        
    } catch (error) {
        console.error("❌ Erro ao consultar PIX:", error.message);
        if (retry < 3) {
            console.log(`🔄 Tentando novamente em 10 segundos... (tentativa ${retry + 1}/3)`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            return consultarPix(retry + 1);
        }
        return [];
    }
}

// ========== ENDPOINTS ==========
// Rota raiz (resolve o erro 404)
app.get("/", (req, res) => {
    res.json({
        status: "online",
        servidor: "PIX ESP32",
        endpoints: ["/consultar", "/status", "/health"],
        versao: "1.0.0"
    });
});

// Health check para o Render
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// Endpoint para o ESP32 consultar créditos
app.get("/consultar", (req, res) => {
    const maquinaId = req.query.maquina;
    
    if (!maquinaId) {
        return res.status(400).json({ error: "Parâmetro 'maquina' é obrigatório" });
    }
    
    // Implementar lógica de créditos pendentes
    res.json({ valor: 0, maquina: maquinaId, timestamp: Date.now() });
});

app.get("/status", (req, res) => {
    res.json({
        status: "online",
        certificado: certBuffer ? "carregado" : "ausente",
        timestamp: Date.now()
    });
});

// ========== INICIALIZAÇÃO ==========
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`✅ Pronto para receber consultas do ESP32`);
    console.log(`📋 Endpoints disponíveis:`);
    console.log(`   GET / - Informações do servidor`);
    console.log(`   GET /health - Health check`);
    console.log(`   GET /status - Status do servidor`);
    console.log(`   GET /consultar?maquina=ID - Consultar créditos`);
    
    // Inicia a consulta PIX após o servidor subir
    setTimeout(() => {
        consultarPix();
        setInterval(() => consultarPix(), 5000);
        console.log("🔄 Sistema de consulta PIX iniciado (intervalo: 5 segundos)");
    }, 3000);
});