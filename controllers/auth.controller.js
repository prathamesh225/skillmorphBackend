import genToken from "../config/token.js"
import User from "../models/user.model.js"
import { verifyFirebaseIdToken } from "../services/firebaseIdentity.service.js"


export const googleAuth = async (req,res) => {
    try {
        const { idToken, firebaseApiKey = "" } = req.body
        const firebaseUser = await verifyFirebaseIdToken(idToken, firebaseApiKey)

        let user = await User.findOne({
            $or: [
                { firebaseUid: firebaseUser.uid },
                { email: firebaseUser.email }
            ]
        })

        if(!user){
            user = await User.create({
                firebaseUid: firebaseUser.uid,
                name: firebaseUser.name, 
                email: firebaseUser.email,
                avatar: firebaseUser.picture
            })
        } else {
            user.firebaseUid = user.firebaseUid || firebaseUser.uid
            user.name = firebaseUser.name || user.name
            user.email = firebaseUser.email || user.email
            user.avatar = firebaseUser.picture || user.avatar || ""
            await user.save()
        }
        let token = await genToken(user._id)
        res.cookie("token" , token , {
            httpOnly:true,
            secure:process.env.NODE_ENV === "production",
            sameSite:"lax",
            maxAge:7 * 24 * 60 * 60 * 1000
        })

        return res.status(200).json(user)



    } catch (error) {
        const errorMessage = String(error?.message || "")
        const status = /(firebase|token|id token|invalid|expired)/i.test(errorMessage) ? 401 : 500
        return res.status(status).json({message:`Google auth error ${error}`})
    }
    
}

export const logOut = async (req,res) => {
    try {
        await res.clearCookie("token" , {
            httpOnly:true,
            secure:process.env.NODE_ENV === "production",
            sameSite:"lax"
        })
        return res.status(200).json({message:"LogOut Successfully"})
    } catch (error) {
         return res.status(500).json({message:`Logout error ${error}`})
    }
    
}
