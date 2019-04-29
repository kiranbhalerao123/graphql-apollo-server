import bcrypt from 'bcryptjs'
import { errorName } from '../define/errors'
import { POST_CREATED } from '../define/variables'
import Post from '../models/post'
import User from '../models/user'
import * as T from '../types/resolver'
import { getForgatePasswordTamplate } from '../utils/getForgatePasswordTamplate'
import getHash from '../utils/getHash'
import { createTokens } from '../utils/getToken'
import { getUuid } from '../utils/getUuid'
import sendMail from '../utils/sendMail'

export const createPost = async (parent: T.Parent, { data }: T.Args, { pubsub, user, redisClient }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const { title, description, type, tags } = data
  const post = new Post({
    title,
    description,
    type,
    tags: [...tags],
    author: {
      id: user._id,
      username: user.username
    },
    createdAt: new Date(),
    updatedAt: new Date()
  })

  await User.findByIdAndUpdate(user._id, {
    $push: { posts: post._id }
  })

  const postRedisId = `post@${post._id}`
  redisClient.set(postRedisId, JSON.stringify(post))

  const userRedisId = `usertimeline@${user._id}`
  redisClient.sadd(userRedisId, postRedisId)

  await pubsub.publish(POST_CREATED, { createdPost: post })

  return post.save()
}

export const updatePost = async (parent: T.Parent, { id, data }: T.Args, { user, redisClient }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const hasPost = user.posts.some((post: string) => post.toString() === id)

  if (!hasPost) {
    throw new Error(errorName.INVALID_POST)
  }

  const updatedPost = await Post.findByIdAndUpdate(
    id,
    {
      ...data,
      updatedAt: new Date()
    },
    { new: true }
  )

  // remove old post from redis cache
  const userRedisId = `usertimeline@${user._id}`
  const postRedisId = `post@${id}`
  await redisClient.srem(userRedisId, postRedisId)

  // add updated post to redis cache
  const updatedPostRedisId = `post@${updatedPost._id}`
  await redisClient.sadd(userRedisId, updatedPostRedisId)

  return updatedPost
}

export const deletePost = async (parent: T.Parent, { id }: T.Args, { user, redisClient }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const hasPost = user.posts.some((post: string) => post.toString() === id)

  if (!hasPost) {
    throw new Error(errorName.INVALID_POST)
  }

  const remainingPosts = user.posts.filter((post: string) => post.toString() !== id)

  await User.findByIdAndUpdate(user._id, {
    posts: [...remainingPosts]
  })

  // remove post from redis cache
  const userRedisId = `usertimeline@${user._id}`
  const postRedisId = `post@${id}`
  await redisClient.srem(userRedisId, postRedisId)

  return Post.findByIdAndDelete(id)
}

export const deleteAllPosts = async (parent: T.Parent, _args: T.Args, { user, redisClient }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  await Post.deleteMany({
    'author.id': user._id
  })

  // remove all post's of user from redis cache
  const userRedisId = `usertimeline@${user._id}`
  await redisClient.del(userRedisId)

  return 'your all posts are deleted'
}

export const userTimeline = async (parent: T.Parent, _args: T.Args, { user, redisClient }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  // remove all post's of user from redis cache
  const userRedisId = `usertimeline@${user._id}`
  const userPosts = await redisClient.smembers(userRedisId)
  const posts = await Promise.all(userPosts.map((postId: string) => redisClient.get(postId)))

  return posts
}

/**
 * user mutation's
 */
export const updateUser = async (parent: T.Parent, { data }: T.Args, { user }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  return User.findByIdAndUpdate(user._id, { ...data }, { new: true })
}

export const deleteUser = async (parent: T.Parent, _args: T.Args, { user }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  await Post.deleteMany({
    'author.id': user._id
  })

  return User.findByIdAndDelete(user._id)
}

export const forgatePassword = async (parent: T.Parent, { email }: T.Args, { redisClient }: any) => {
  const user: any = await User.findOne({ email })
  const key = getUuid()
  const uid = user._id.toString()
  await redisClient.set(key, uid, 'EX', 1800)

  const link = `${process.env.BASE_URL}/forgate/password/${key}`
  const subject = 'Forgate Password'
  const template = getForgatePasswordTamplate(link, user.username)

  sendMail(email, subject, template)

  return 'Check your mail and recreate your password.'
}

export const signup = async (parent: T.Parent, { data }: T.Args) => {
  const { email, username, password } = data

  const userExist: any = await User.findOne({ email })
  if (userExist) throw new Error('Email already rigistered')

  const hashPassword = await getHash(password)
  await new User({
    email,
    username,
    password: hashPassword,
    createdAt: new Date()
  }).save()

  return `Welcome ${username}, your registration done successfully.`
}

export const login = async (parent: T.Parent, { data }: T.Args) => {
  const { email, password } = data

  const user: any = await User.findOne({ email })
  if (!user) throw new Error('invalid email')

  const isMatch = await bcrypt.compare(password, user.password)
  if (!isMatch) {
    throw new Error('invalid password.')
  }
  const [accessToken, refreshToken] = await createTokens(user)

  return {
    accessToken,
    refreshToken,
    message: 'User login successfully.'
  }
}

export const likeDislikePost = async (parent: T.Parent, { postId }: T.Args, { user }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const hasPost: any = await Post.findById(postId)

  if (!hasPost) {
    throw new Error(errorName.INVALID_POST)
  }

  const alreadyLikedPost = hasPost.likes.users.some((userId: any) => userId.toString() === user._id.toString())

  const likedPost = () =>
    Post.findByIdAndUpdate(postId, { $inc: { 'likes.count': 1 }, $push: { 'likes.users': user._id } }, { new: true })

  const disLikedPost = () =>
    Post.findByIdAndUpdate(postId, { $inc: { 'likes.count': -1 }, $pull: { 'likes.users': user._id } }, { new: true })

  return alreadyLikedPost ? disLikedPost() : likedPost()
}

export const commentPost = async (parent: T.Parent, { postId, comment }: T.Args, { user }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const hasPost = await Post.findById(postId)

  if (!hasPost) {
    throw new Error(errorName.INVALID_POST)
  }

  return Post.findByIdAndUpdate(
    postId,
    {
      $push: { 'comments.comment': comment, 'comments.user.userId': user._id, 'comments.user.username': user.username }
    },
    { new: true }
  )
}

export const followUser = async (parent: T.Parent, { followingId }: T.Args, { user }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const followingUser: any = await User.findById(followingId)

  if (!followingUser) {
    return new Error('You can not follow unexist user.')
  }

  const isFollowing = followingUser.followings.some((id: any) => id.toString() === followingId)
  if (isFollowing) {
    // tslint:disable-next-line: prettier
    return new Error('You already follows that user.')
  }

  // add userID to following users followers array
  await User.findByIdAndUpdate(followingId, {
    $push: { followers: user._id }
  })

  // add followingid to current users followings array
  return User.findByIdAndUpdate(
    user._id,
    {
      $push: { followings: followingId }
    },
    { new: true }
  )
}

export const unFollowUser = async (parent: T.Parent, { followingId }: T.Args, { user }: any) => {
  if (!user) {
    throw new Error(errorName.UNAUTHORIZED)
  }

  const followingUser: any = await User.findById(followingId)

  if (!followingUser) {
    // tslint:disable-next-line: prettier
    return new Error('You can\'t unfollow the user which is not exists.')
  }

  const isFollowing = followingUser.followings.some((id: any) => id.toString() === followingId)
  if (!isFollowing) {
    // tslint:disable-next-line: prettier
    return new Error('You can\'t unfollow the user which you are not following.')
  }

  await User.findByIdAndUpdate(followingId, {
    $pull: { followers: user._id }
  })

  return User.findByIdAndUpdate(
    user._id,
    {
      $pull: { followings: followingId }
    },
    { new: true }
  )
}
