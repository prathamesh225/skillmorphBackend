import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    firebaseUid:{
        type:String,
        unique:true,
        sparse:true,
        index:true
    },
    name:{
        type:String,
        required:true
    },
    email:{
        type:String,
        unique:true,
        required:true
    },
    avatar:{
        type:String,
        default:""
    },
    credits:{
        type:Number,
        default:1000
    },
    quizOverallSummary: {
        headline: { type: String, default: '' },
        summary: { type: String, default: '' },
        strengths: { type: [String], default: [] },
        weakAreas: { type: [String], default: [] },
        timingInsights: { type: [String], default: [] },
        disciplineInsights: { type: [String], default: [] },
        nextActions: { type: [String], default: [] }
    },
    quizOverallSummaryUpdatedAt: {
        type: Date,
        default: null
    },
    quizOverallSummarySampleSize: {
        type: Number,
        default: 0
    }

}, {timestamps:true})

const User = mongoose.model("User" , userSchema)

export default User
