import express from "express"
import dotenv from "dotenv"
import connectDb from "./config/connectDb.js"
import cookieParser from "cookie-parser"
dotenv.config()
import cors from "cors"
import authRouter from "./routes/auth.route.js"
import userRouter from "./routes/user.route.js"
import interviewRouter from "./routes/interview.route.js"
import paymentRouter from "./routes/payment.route.js"
import quizRouter from "./routes/quiz.route.js"

const app = express()
app.use(cors({
    origin:"http://localhost:5173",
    credentials:true
}))

app.use(express.json())
app.use(cookieParser())

app.use("/api/auth" , authRouter)
app.use("/api/user", userRouter)
app.use("/api/interview" , interviewRouter)
app.use("/api/quiz" , quizRouter)
// app.use("/api/payment" , paymentRouter)

const PORT = process.env.PORT || 6000
const quizModel = process.env.GROQ_QUIZ_MODEL || 'openai/gpt-oss-120b'
const summaryModel = process.env.GROQ_SUMMARY_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'

const bootstrap = async () => {
    try {
        await connectDb()
        app.listen(PORT , ()=>{
            console.log(`Server running on port ${PORT}`)
            console.log(`[AI][config] quizModel=${quizModel} summaryModel=${summaryModel}`)
        })
    } catch (error) {
        console.log(`DataBase Error ${error}`)
        process.exit(1)
    }
}

bootstrap()
