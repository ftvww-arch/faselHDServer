const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'يرجى تمرير رابط url صالح في الطلب.' });
    }

    // استخراج IP المستخدم الحقيقي الذي يزور الـ API الخاص بك
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    // تنظيف الـ IP في حال كان هناك أكثر من IP (يحدث خلف البروكسيات)
    if (clientIp && clientIp.includes(',')) {
        clientIp = clientIp.split(',')[0].trim();
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Referer': 'https://www.fasel-hd.co/',
                // حقن الـ IP الخاص بالمستخدم في الهيدرز لمحاولة خداع سيرفر الموقع
                'X-Forwarded-For': clientIp,
                'X-Real-IP': clientIp,
                'Client-IP': clientIp
            }
        });

        const htmlContent = response.data;
        const scriptMatch = htmlContent.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);

        if (!scriptMatch) {
            return res.status(404).json({ error: 'لم يتم العثور على سكريبت المشغل المشفر.' });
        }

        const scriptCode = scriptMatch[1];

        // البيئة الوهمية الآمنة
        const sandbox = {
            document: {
                getElementById: () => ({
                    canPlayType: () => false,
                    src: ''
                })
            },
            window: {},
            Hls: { isSupported: () => false },
            setInterval: () => {},
            setTimeout: () => {},
            console: { log: () => {}, warn: () => {}, error: () => {} }
        };

        sandbox.window = sandbox;
        sandbox.global = sandbox;

        vm.createContext(sandbox);
        vm.runInContext(scriptCode, sandbox);

        if (sandbox.videoSrc) {
            const streamDomainObj = new URL(sandbox.videoSrc);
            
            return res.json({
                success: true,
                server_url: streamDomainObj.origin,
                stream_url: sandbox.videoSrc, // هذا الرابط يفترض أن يعمل الآن عند المستخدم
                client_ip_used: clientIp, // أضفناه للتأكد من التقاط الـ IP الصحيح
                headers: {
                    "Origin": "https://www.fasel-hd.co",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    "Referer": "https://www.fasel-hd.co/"
                }
            });
        } else {
            return res.status(500).json({ error: 'لم يتم العثور على الرابط بعد فك التشفير.' });
        }

    } catch (error) {
        return res.status(500).json({ 
            error: 'حدث خطأ أثناء معالجة الطلب.', 
            details: error.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
