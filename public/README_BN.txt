NovaDesk Online — চালানোর নিয়ম

যা আছে
- নিজস্ব সরল নিয়মভিত্তিক বাংলা উত্তর ব্যবস্থা; কোনো প্রস্তুত AI মডেল বা AI API নেই।
- শেখানো তথ্য সার্ভারের data/knowledge.json ফাইলে সংরক্ষণ হয়।
- DuckDuckGo HTML দিয়ে ওয়েব সার্চ; এটি বাহ্যিক সার্চ ইঞ্জিন, AI মডেল নয়।
- ওয়েব অ্যাপ হিসেবে চালানো যায়।

লোকাল কম্পিউটারে চালাতে
1. Node.js 18 বা নতুন সংস্করণ ইনস্টল করুন।
2. এই ফোল্ডারে টার্মিনাল খুলুন।
3. চালান: npm start
4. ব্রাউজারে খুলুন: http://localhost:3000

অনলাইনে প্রকাশ করতে
1. পুরো প্রজেক্টটি GitHub repository-তে আপলোড করুন।
2. Node.js web service সমর্থন করে এমন hosting-এ repository connect করুন।
3. Build command ফাঁকা রাখুন; Start command: npm start
4. Persistent disk/storage যুক্ত করে DATA_DIR-কে সেই disk path-এ সেট করুন।
5. hosting যে HTTPS URL দেবে সেটি দিয়ে যেকোনো ডিভাইসে খুলুন।

গুরুত্বপূর্ণ
- Hosting ছাড়া এই কোড নিজে থেকে ইন্টারনেটে প্রকাশ পাবে না।
- Persistent storage না থাকলে hosting restart/deploy-এর পর শেখানো তথ্য হারাতে পারে।
- DuckDuckGo HTML parsing পরিবর্তিত হলে সার্চ ফলাফল কাজ নাও করতে পারে।
- এই AI এখনো সাধারণ জ্ঞানসম্পন্ন neural network নয়। এটি শেখানো তথ্যের মিল খুঁজে নিয়মভিত্তিক উত্তর দেয়।
- সার্চ ফলাফল যাচাই করে পড়ুন; NovaDesk এখনো ওয়েবসাইটের তথ্যের সত্যতা নিজে যাচাই করে না।
- Production ব্যবহারের আগে login/authentication, rate limiting, HTTPS এবং private per-user database যোগ করা দরকার। বর্তমান demo-তে knowledge store সবার জন্য উন্মুক্ত।
