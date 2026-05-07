require('dotenv').config();
const express = require("express");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const CLIENT_ID = process.env.EFI_CLIENT_ID;
const CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;

// 🔥 NOVO: Pega o certificado da variável de ambiente
const CERTIFICADO_BASE64 = process.env.EFI_CERTIFICADO_BASE64;

// Converte o certificado de Base64 para Buffer
let certBuffer = null;

if (CERTIFICADO_BASE64) {
    certBuffer = Buffer.from(CERTIFICADO_BASE64, 'base64');
    console.log("✅ Certificado carregado da variável de ambiente");
} else {
    // Fallback: tenta ler do arquivo (para teste local)
    const fs = require("fs");
    try {
        certBuffer = fs.readFileSync("./cert.p12");
        console.log("✅ Certificado carregado do arquivo local");
    } catch (err) {
        console.error("❌ Certificado não encontrado!");
        console.error("   Configure a variável EFI_CERTIFICADO_BASE64");
        process.exit(1);
    }
}

// Mapeamento das máquinas
const MAQUINAS = {
    "VWnLMVAtxc1SKBIt21YfanMAq1": {
        nome: "Máquina 1",
        endpoint: process.env.MAQUINA_1_URL
    }
};

let creditosPendentes = {};
let processedPix = new Set();
let tokenCache = { value: null, expiresAt: 0 };

// Função para criar o Agent HTTPS com o certificado
function getHttpsAgent() {
    return new https.Agent({
        pfx: certBuffer,
        passphrase: ""
    });
}

// ========== FUNÇÃO PARA OBTER TOKEN ==========
async function getToken() {
    if (tokenCache.value && tokenCache.expiresAt > Date.now() + 300000) {
        return tokenCache.value;
    }
    
    try {
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
        
        const response = await axios.post(
            "https://api-pix.efipay.com.br/oauth/token",
            { grant_type: "client_credentials" },
            {
                httpsAgent: getHttpsAgent(),
                headers: {
                    "Authorization": `Basic ${auth}`,
                    "Content-Type": "application/json"
                }
            }
        );
        
        tokenCache.value = response.data.access_token;
        tokenCache.expiresAt = Date.now() + 6900000;
        
        console.log("✅ Token obtido com sucesso");
        return tokenCache.value;
        
    } catch (error) {
        console.error("❌ Erro ao obter token:", error.response?.data || error.message);
        throw error;
    }
}

// ========== FUNÇÃO PARA CONSULTAR PIX ==========
async function consultarPix() {
    try {
        const token = await getToken();
        
        const agora = new Date();
        const inicio = new Date(agora.getTime() - 300000);
        
        const response = await axios.get(
            `https://api-pix.efipay.com.br/v2/pix?inicio=${inicio.toISOString()}&fim=${agora.toISOString()}`,
            {
                httpsAgent: getHttpsAgent(),
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            }
        );
        
        const pixList = response.data.pix || [];
        
        for (const pix of pixList) {
            const endToEndId = pix.endToEndId;
            
            if (processedPix.has(endToEndId)) continue;
            
            processedPix.add(endToEndId);
            
            if (processedPix.size > 1000) {
                const toDelete = [...processedPix][0];
                processedPix.delete(toDelete);
            }
            
            const txid = pix.txid;
            const valor = Math.floor(parseFloat(pix.valor));
            
            console.log(`💰 PIX detectado: TXID=${txid}, Valor=R$${valor}`);
            
            if (MAQUINAS[txid]) {
                if (!creditosPendentes[txid]) {
                    creditosPendentes[txid] = 0;
                }
                creditosPendentes[txid] += valor;
                
                console.log(`✅ Crédito de R$${valor} adicionado para ${MAQUINAS[txid].nome}`);
            } else {
                console.log(`⚠️ TXID não mapeado: ${txid}`);
            }
        }
        
    } catch (error) {
        console.error("❌ Erro ao consultar PIX:", error.response?.data || error.message);
    }
}

// ========== ENDPOINTS ==========
app.get("/consultar", (req, res) => {
    const maquinaId = req.query.maquina;
    
    if (!maquinaId) {
        return res.status(400).json({ error: "Parâmetro 'maquina' é obrigatório" });
    }
    
    if (!MAQUINAS[maquinaId]) {
        return res.json({ valor: 0 });
    }
    
    const credito = creditosPendentes[maquinaId] || 0;
    
    if (credito > 0) {
        creditosPendentes[maquinaId] = 0;
        console.log(`🎯 Crédito de R$${credito} entregue para ${MAQUINAS[maquinaId].nome}`);
    }
    
    res.json({ valor: credito, timestamp: Date.now() });
});

app.get("/status", (req, res) => {
    const status = {};
    for (const [id, maq] of Object.entries(MAQUINAS)) {
        status[id] = {
            nome: maq.nome,
            creditosPendentes: creditosPendentes[id] || 0
        };
    }
    res.json({
        maquinas: status,
        totalProcessados: processedPix.size
    });
});

// ========== INICIALIZAÇÃO ==========
if (CLIENT_ID && CLIENT_SECRET && certBuffer) {
    // Executa primeira consulta
    consultarPix();
    // Agenda consultas periódicas
    setInterval(consultarPix, 5000);
    console.log("🔄 Sistema de consulta PIX iniciado (intervalo: 5 segundos)");
} else {
    console.error("❌ Configuração incompleta!");
    console.error("   Verifique EFI_CLIENT_ID, EFI_CLIENT_SECRET e EFI_CERTIFICADO_BASE64");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`✅ Pronto para receber consultas do ESP32`);
});

process.on('SIGTERM', () => process.exit(0));