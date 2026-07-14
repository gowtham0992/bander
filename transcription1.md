# Build Week: Welcome — OpenAI Developers Live Broadcast

**Broadcaster:** OpenAI Developers (@OpenAIDevs)
**Date:** July 13, 2026 · 10:01 AM PDT
**Duration:** ~35 minutes
**Views:** 6,844
**Source:** [X Broadcast](https://x.com/i/broadcasts/1qJDzzEDBqoKV)

---

> [!NOTE]
> The first ~8 minutes of the broadcast appear to be pre-roll / holding screen with no speech (silence). The transcription begins when speakers start talking.

## Speakers
- **Host** (OpenAI DevEx/DevRel lead — likely Romain Huet based on context)
- **Greg** (Greg Brockman or senior engineering lead)
- **Tibo** (Thibault Imbert, ChatGPT product lead)

---

## Transcription

### Part 1: Conversation with Greg & Tibo — The Developer Moment

...building something really complex, you can actually open `/side` and just get an insight to what's happening and kind of steer it from there.

**Host:** On the note of building and the complexity of what people can build, why is it a really exciting time for developers right now? What about this moment and the tools available make it extremely powerful for developers to do even more?

**Greg:** Well, first of all, I think the evidence is right for this moment that I think that we have this AI that is able to do so much of the kind of very mechanical kind of work, but increasingly also a lot of interesting algorithmic work and even starting to do design and things like that. And some people expected that, well, that means that now there'd just be less development to do, right? That we'd all get to relax a little bit more. I think that the evidence so far is the opposite, right? That I think that developers are just seeing how much that if they're not guiding these agents, not providing all this oversight, it's wasted time. You don't get that time back.

And of course, you know, I think the past may not predict the future, but I think that there's something that's very surprising that's happening. And if there's one thing that I have learned about AI over the years, it's that it is a surprising thing and somehow things play out very differently from what you'd expect. So I think it is the most exciting time it has ever been to be an engineer, and you can just get so much more done and translate your vision into reality. And that is actually the hardest part — having that vision in the first place.

**Host:** Yes, having a problem, solving it, has never been more fun. One of the star examples — like for developers, for game developers as well. I think it's just an awesome experience now. I was just watching an example from Andrew. He leads the desktop development and he just ran five, six — all in the background on a `/goal` — over the course of a week to build a full Minecraft experience. And not only that, then once it was built, he had queued up another prompt, which is like "once you're done with the Minecraft simulation, re-implement the whole city of San Francisco. And don't ever stop, just keep building." And he was checking on it every day. And there were more and more details — libraries, schools, entire offices, parks, details being added left and right. Fully autonomously.

It's just — really, o4-mini/o5 would have never been able to do this. And you just need to keep raising your level of ambition. I think people haven't quite yet seen the limits of o5/o6-all. And it's just — you need to keep pushing it and pushing it. And also it's much more efficient. So you can just get so much more done and so much more quickly.

I'm really excited to see so many people who are participating and building this week. It's only day zero. We just kicked off this week. And we have over 10,000 people who've signed up for participating and also attending our events. So I can't believe this is just where we started and I'm excited to see where we're going throughout the week.

**Host:** Tibo, on that note of what Andrew's built and kind of how he used o5/o6-all to actually build a really fun game — he walked me through the new ChatGPT app and kind of the direction we're headed. What's the larger vision?

**Tibo:** Yeah. So what we did last week is we announced ChatGPT Work, which is a very powerful agent right in the ChatGPT app. It works on mobile. It works on web. And then we have an all-new ChatGPT desktop app as well where we combined ChatGPT and Codex. And this just really gives everyone who has a subscription with ChatGPT the ability to benefit from the same things that all of us and developers have benefited from, which is a very autonomous and powerful agent that can just do things for you.

When you combine that with plugins and access to all your data and also local files and access to Chrome, it's just really exciting because suddenly you can see people who are not in code every day just also be able to get things done and go through their calendar and plan their days.

And the vision there is simplicity, not complexity. We're really going towards a very powerful personal agent that knows everything about your day-to-day lives, your goals, what you've done last week, what your personal aspirations are, what you want to learn. And then can help you, help your team, help your company get things done and be more productive. And so that's the direction that we're headed. And this is also why we believe in this unified product.

**Greg:** Yeah, and just to add to that, I think at OpenAI, we really stand for and really care about access. We really care about bringing this technology broadly, making it widely available, empowering people, putting that power in your hands. And the same is also true on pricing, right? If you look at what we've been solving for with Sol/Terra/Luna, is to be at the Pareto Frontier of price-performance, right? So for any task, we want to be the most price-effective option. And also to the most ambitious task, be able to have the ceiling of performance.

And so I'd actually be very curious to see — anytime we see any other model that is able to achieve a task for cheaper than us, we really want to know. Send us that feedback and we'll fix it.

**Host:** I think the efficiency story is extremely powerful on top of our vision.

---

### Part 2: Practical Developer Advice

**Host:** So on the note of a new ChatGPT app or new models — it's very topical for developers that the industry is moving so quickly and the tools are moving so quickly. What are some practical ways developers can prepare as the innovation and the tooling changes on a weekly basis even?

**Greg:** My number one piece of advice is to lean in. I think we've seen for generation after generation of this technology that the people who spend the most time playing with the current gen and figuring out how to get the most out of it tend to be the people who get the most out of the next gen, right? There's something about this creativity and agency — just having a vision and trying to really explore what's possible in these models. That's a transferable and very durable skill.

**Tibo:** Yeah, it's really all about leaning in but also keeping it simple. I think every time we release new models, you realize, "Oh, maybe you were a little bit too specific in the way that you defined your workflows and skills." And now suddenly, that scaffolding is not really important anymore and it's holding the model back. So always going back to the fundamentals and understand that we're always optimizing the experience for understanding humans and natural language and being a tool that makes you more productive so that you don't have to adopt to it but it adopts to you. And over time, it just gets more and more natural.

---

### Part 3: Agent Orchestration & Context

**Host:** On that note — the way we use agents today, moving beyond coding assistance to kind of a full agent orchestration across all of your work — how do people think about that and where do we try to make that easier for people to have the context they need to build what they want to build?

**Tibo:** A lot of the context is on your computer. This is why we have the ChatGPT desktop app so that it works with your local files. We have released over 150 different plugins as well so that you can connect your docs, your calendar, your email — anything else, any other tool that you work with. Obviously, we also support MCP servers so you can bring in more context. And then we have best-in-class memory systems so that Codex just learns over time — how you like to get things done, learns your voice. For example, if you use it to help you with writing, it learns your preferences. So you don't have to always bring in the additional context by typing very long prompts. It becomes more and more succinct and more and more efficient.

---

### Part 4: Favorite Features

**Host:** Out of all the exciting features across plugins, automations, sites, doing code review — any personal favorites? Things that you found extremely powerful and exciting that maybe developers have missed?

**Greg:** Well, I will say being able to do much more ambitious tasks is very exciting, but one thing I find very impactful on a day-to-day basis is all the little gap-filling that you realize you used to spend a lot of time on. For example, if there's some project that's running and I just haven't paid attention to it recently and I'm curious how it's going — normally I'd ping someone, maybe ping multiple people. Instead I just ask Codex, right? And it just goes and reads all the docs, it reads through Slack, it reads through all the commits, and it can tell me exactly what's going on. Answering any kind of question with data — it just goes and does it. I don't have to think about "here's this table, what do all the columns mean?" It just does it.

And I think that's that empowerment of: you can just go do things, you can just go learn things, you can just go observe things. I love that. It just makes it so much more fun to work.

**Tibo:** My personal favorite of the many features we've shipped recently is the inline visualizations. So Codex can now express itself not just in text, but also inline some HTML, and it allows you to communicate and understand it in a very visual and interactive way. And then you can take that and bring it further and host it as a website. And we've seen a ton of people just share little sites with each other instead of sharing static docs. This is just really a new way of communicating information.

And then one thing that I love receiving from designers or anyone on the team is also little prototypes. Instead of sending me a mock and then brainstorming around something that is static, it's "hey, Codex, why don't you implement this wild idea that we just had, host it on a website and then share it in a secure way." And then iterating on that is just really, really super fun.

---

### Part 5: Community Engagement & Feedback

**Host:** So all the different features I'm mentioning — one quick plug is we launched a new docsite: learn.openai.com. DevEx, we've really been powerfully putting a lot of content into developers.openai.com, but we have an additional site now for you to learn more about this information.

Tibo, we were talking just before this live stream about how you engage with the community, which I think has been a phenomenal way to get feedback. You use sites in an interesting way. Can you tell me more about it?

**Tibo:** Yeah, on the community — we've always engaged very deeply with the community and super openly. This is one thing that when I decided to come here and work at OpenAI, something that was just really fascinating and immediately found appealing — you need to talk to your users, to the community, to everyone, and just be out there. And you'll learn so much from direct interaction.

And we saw like with o5/o6-all, the reception was just super, super positive. I don't think we've had such a strongly positive reaction in a while. It's just an incredible model release. And then there are some things where we had a ton of good feedback from the community on the release of the desktop app. And then it allows us — just by being out there and directly engaging with everyone and just listening to the feedback — it allows us to just put a better product out there, like the very next day, or in the next couple of hours. Just iterate super quickly. And that's very important for us — to be in tune with what you all want. And then continuously improve the experience.

And now that we have o5/o6-all and we're going to continue to iterate on the capability of the models, we're also able to iterate so much more quickly. So it's very important to compress how quickly you get feedback and then how quickly you put the next iteration out there. Being in direct tune and grounded with the community is ever more important.

**Host:** I 100% agree. Do you track these themes? How do you intake all this feedback in a way that's productive?

**Tibo:** Yeah — Codex processes everything, synthesizes it all, and then we can cut the top themes. It's like all the information just gets processed automatically.

**Host:** So here's a question. Can you remember what it was like to do all this work before Codex?

**Tibo:** It was a lot. It was a very slow process, multiple teams, and you would always get the themes a little bit too late. And now it's like, every time I have a question it's just — "OK, go check out Twitter," sometimes other sources of information, and then synthesize it all. Like literally five minutes later I have a very extensive report.

---

### Part 6: What to Build This Week

**Host:** Greg, one of the questions I'd love for you to answer and share for folks: What are you excited to see people build this week? Open-ended, specific — love to hear thoughts.

**Greg:** Well, I think there's a wide variety of answers here, because I think that this is really about an exploration into what's possible. What does Sol, what do these other models really unlock? And I think that many people have a vision of something that they've always been excited to build and haven't seen it in the world. Try that, make it happen, make it into reality.

Sometimes I think it can also be exciting to think about just doing some of the "boring work," so to speak — the backlog of doing a code migration from one language to another. Some of the projects I enjoy seeing the most are the "rewrite this thing in Rust" and then you get all these performance benefits, all this correctness benefits.

I think really trying to push in a direction where — some of the most exciting stories I've heard is people who say that in the past couple weeks they've written more software than they did in the past 10 years. Literally had someone tell me that the other day, and I think that it's true. And so really trying to see: is it possible to just do more, to make things come into existence that you just would not be ambitious enough to dream otherwise?

**Host:** Awesome. I think that's a perfect place to wrap off to inspire everybody else who's building right now. Thank you both Greg and Tibo for joining us today and helping us kick off Build Week.

**Greg:** Thank you. And thank you to the builders out there. Good luck and have fun.

---

### Part 7: Host Solo — Build Week Logistics & Walkthrough

Hey everyone. I'm super excited to kick off Build Week. Thank you again for Greg and Tibo for sharing their thoughts and being with us here today. Here I am on openai.com/build-week. This is your place for you to find all the information about what's happening this week. I really love this landing page — we had the countdown timer before we kicked off and now this is the countdown timer for submissions.

I'm going to scroll down to the timeline for the week. So today is July 13th and the challenge is open. Start forming teams. People are already starting to build and it's been really exciting to see. Some of the developer meetups are already happening.

As a reminder, **July 21st is the submission deadline.** So as you're building throughout the week, as you're iterating with Codex, keep that date in mind as you need to prepare.

Our judges for the week are Tibo, Cath (product team), Tara (product team), Leah (education team), and Peter Steinberger.

#### Sessions Throughout the Week

- **Tomorrow:** Another live stream — the host will talk to Peter about what he's been working on, how he builds, how he manages many agents at scale, plus some fun things live.
- **July 15th:** Office hours on Discord — the full DevEx team across OpenAI will be available to answer questions, help unblock you, and see what you're building.
- **July 16th:** Codex Sites Academy session — learn more about how to build and deploy with Sites.
- More office hours throughout the week.
- **Next week:** Wrap-up live stream to share what was seen, projects that were built, content from all the different IRL events.

#### Community Events

Events are happening all around the world — Brazil, Austria, San Francisco, and across APAC. Three have already kicked off in Sydney and Korea. All events are listed on the official Luma page (linked on the Build Week site). Events are free to attend but many are selling out, so sign up early.

#### DevPost — Hackathon Logistics

The DevPost site (linked from openai.com/build-week) has all the logistics, requirements, and categories. There's an official DevPost hackathon plugin for Codex — you can use it directly in Codex without switching tabs to learn about requirements, check your project against them, and even submit your project agentically.

**Categories:**
1. Apps for Your Life
2. Work and Productivity
3. Developer Tools
4. Education

> [!IMPORTANT]
> Projects are encouraged to be fresh/new. You can work off an existing project, but submissions must clearly show what is net-new for Build Week and how Codex was used.

> [!IMPORTANT]
> **Required:** Run `/feedback` to get your Codex session ID. This must be submitted as a required field so OpenAI can verify your use of Codex.

**Prizes:** Cash prizes, swag, OpenAI subscriptions, and opportunities to meet with the OpenAI team.

---

### Part 8: Codex Hackathon Demo — Building a Game Live

The host demonstrates kicking off a long-running Codex task to build a game inspired by a trip to the Dolomites:

1. **Started with a big vision prompt** — describing the game idea, core action, vibe, and details about wanting an open-world game inspired by the Dolomites region.
2. **Codex generated initial concept art** using image gen under the hood.
3. **Built a working prototype** to test out the direction.
4. **Provided feedback** — ensuring movement controls and the map are functional.
5. **Generated a long-running goal** and kicked it off — Codex will build continuously throughout the week.

#### Tips Shared:

- **`/side`** — Open a concurrent side thread to check on progress while the main task runs. You can talk to Codex in a different thread that has insight into your main thread. Great for steering, getting updates, or sharing progress with teammates.
- **Dictation** — You can dictate to Codex instead of typing. Great way to let your thoughts flow naturally into what you want to build.

---

### Part 9: Infinite Build Site

A site was launched using the Sites plugin to guide anyone in the world on how to run their own long-running task loop:

1. **Start with your idea** — fill in the prompt template with your ideas
2. **Review concepts with Codex** — it builds a prototype to test
3. **Give feedback** — shape the art direction, typography, specific libraries
4. **Generate a long-running goal** — structure your project to work indefinitely

---

### Closing

Thank you everybody for joining our live stream today. Please check out the OpenAI Build Week site. We've had Greg and Tibo join to share their thoughts. I've walked through the logistics, shared the set of community events happening around the world, and I've actually kicked off Codex to participate in the hackathon. Really excited to see what you can build, and I look forward to seeing you in the next live stream and online.
