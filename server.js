const axios = require('axios');
const vm = require('vm'); // وحدة مدمجة في Node.js ولا تحتاج لتثبيت

async function getFaselStreamData(targetUrl) {
  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': 'https://www.fasel-hd.co/'
      }
    });

    const htmlContent = response.data;

    // 1. استخراج كود المشغل المشفر بالكامل كما هو للحفاظ على التنسيق وتخطي حماية Obfuscator
    const scriptMatch = htmlContent.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);

    if (!scriptMatch) {
      console.log('لم يتم العثور على سكريبت المشغل المشفر.');
      return;
    }

    const scriptCode = scriptMatch[1];

    // 2. تجهيز بيئة وهمية (Sandbox) آمنة تحاكي المتصفح
    const sandbox = {
      document: {
        getElementById: () => ({
          canPlayType: () => false,
          src: ''
        })
      },
      window: {},
      Hls: {
        isSupported: () => false
      },
      // تعطيل دوال التوقيت لمنع أي Infinite Loops يزرعها التشفير كفخ
      setInterval: () => {},
      setTimeout: () => {},
      console: { log: () => {}, warn: () => {}, error: () => {} }
    };

    // ربط البيئة الوهمية لتخطي فحص الكود لخصائص المتصفح
    sandbox.window = sandbox;
    sandbox.global = sandbox;

    // 3. تشغيل الكود المشفر داخل البيئة الوهمية ليفك تشفير نفسه برمجياً
    vm.createContext(sandbox);
    vm.runInContext(scriptCode, sandbox);

    // 4. استخراج الرابط المباشر بعد تجميعه بواسطة الكود نفسه
    if (sandbox.videoSrc) {
      console.log('====================================');
      console.log('تم استخراج الرابط المباشر بنجاح:');
      console.log(sandbox.videoSrc);
      console.log('====================================');
      return sandbox.videoSrc;
    } else {
      console.log('لم يتم العثور على الرابط بعد تنفيذ الكود.');
    }

  } catch (error) {
    console.error('حدث خطأ أثناء التنفيذ:', error.message);
  }
}

getFaselStreamData('https://www.fasel-hd.co/video_player?player_token=OXVudUFOVnhzMXJKeVJ6am5ZYkkvSk1HU3VaS0hoZFNwUHVDRVk3QktSbmM5V3N1NDE2QTB0VVQ3MEQ0NFR1K2cvOXpscXIySEt4ZTZpMHZ6MGpLdGFmR3VpMERsczB2WHgxMVNERSthQWxKdGR2OVVxZXpkVlRPMGhRRytXYW8zYjBqQTBYUk1QcHU5SlNhQ1ExSk5TNGNQQ1ZJalZqMXBHRWw0bVl6Wmg5eldEYWhQVmlsaEhpYjFqSysraHJjUk15bkI0VU9tS1NqbnBpdG5DWmJwWnp3UWJEOU95dkRBTGRpVFhHMGRnMDlYbjlNazB5bUJQSWpFL0g2TDExVjo6lahF6AOml1x7y1nfMcd8kw%3D%3D');
