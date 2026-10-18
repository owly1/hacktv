"""Brief optical tracking of an already decoded QR; never authorizes a new fire."""
import cv2
import numpy as np


class QRVisualTrack:
    max_decode_age=2.5

    def __init__(self):self.clear()

    def clear(self):
        self.gray=self.features=self.corners=None
        self.at=self.decoded_at=None

    def seed(self,gray,corners,at):
        self.clear()
        corners=np.asarray(corners,np.float32).reshape(4,2)
        mask=np.zeros(gray.shape,np.uint8)
        cv2.fillConvexPoly(mask,np.round(corners).astype(np.int32),255)
        features=cv2.goodFeaturesToTrack(gray,100,.03,3,mask=mask,blockSize=3)
        if features is None or len(features)<12:return
        self.gray=gray.copy();self.features=features;self.corners=corners
        self.at=self.decoded_at=at

    def follow(self,gray,at):
        if (self.gray is None or gray.shape!=self.gray.shape or not 0<at-self.at<=.5
                or not 0<=at-self.decoded_at<=self.max_decode_age):
            self.clear();return None
        try:
            nxt,ok,_=cv2.calcOpticalFlowPyrLK(self.gray,gray,self.features,None,winSize=(21,21),maxLevel=3)
            if nxt is None:raise ValueError()
            back,reverse,_=cv2.calcOpticalFlowPyrLK(gray,self.gray,nxt,None,winSize=(21,21),maxLevel=3)
            if back is None:raise ValueError()
            good=(ok.ravel()==1)&(reverse.ravel()==1)&(np.linalg.norm(back-self.features,axis=2).ravel()<1.2)
            before=self.features.reshape(-1,2)[good];after=nxt.reshape(-1,2)[good]
            if len(before)<12 or len(before)<len(self.features)*.55:raise ValueError()
            transform,inliers=cv2.findHomography(before,after,cv2.RANSAC,1.5)
            if transform is None or inliers is None:raise ValueError()
            valid=inliers.ravel().astype(bool)
            if valid.sum()<10 or valid.mean()<.7:raise ValueError()
            old_area=abs(cv2.contourArea(self.corners))
            if abs(cv2.contourArea(cv2.convexHull(before[valid])))<old_area*.2:raise ValueError()
            corners=cv2.perspectiveTransform(self.corners[None],transform)[0]
            area=abs(cv2.contourArea(corners))
            h,w=gray.shape
            if (not np.isfinite(corners).all() or not cv2.isContourConvex(corners)
                    or not .65<=area/max(old_area,1)<=1.5
                    or np.max(np.linalg.norm(corners-self.corners,axis=1))>80
                    or np.any(corners<2) or np.any(corners[:,0]>w-3) or np.any(corners[:,1]>h-3)):
                raise ValueError()
            self.gray=gray.copy();self.features=after[valid].reshape(-1,1,2);self.corners=corners;self.at=at
            return corners.copy()
        except (ValueError,cv2.error):
            self.clear();return None


class QRTemplateTrack:
    """Re-identify an exact-decoded QR using fresh whole-pattern evidence.

    A finder quadrilateral alone is never a hit. It must align to the immutable
    decoded reference, including its data cells (not just shared QR finders).
    This lets a small but visible code survive decoder failures at cruise height.
    """
    max_decode_age=300.
    max_visual_gap=15.
    size=128

    def __init__(self):self.clear()

    def clear(self):
        self.reference=self.modules=None;self.decoded_at=self.visual_at=None

    @staticmethod
    def correlation(a,b):
        a=a.astype(np.float64);b=b.astype(np.float64)
        a=a-a.mean();b=b-b.mean()
        denominator=np.linalg.norm(a)*np.linalg.norm(b)
        return float(np.dot(a.ravel(),b.ravel())/denominator) if denominator>1e-6 else -1.

    def _quad(self,gray,corners):
        points=np.asarray(corners,np.float32).reshape(4,2);h,w=gray.shape
        edge=min(np.linalg.norm(points[i]-points[(i+1)%4]) for i in range(4))
        if (not np.isfinite(points).all() or not cv2.isContourConvex(points)
                or edge<20 or np.any(points<2) or np.any(points[:,0]>w-3)
                or np.any(points[:,1]>h-3)):raise ValueError()
        square=np.array([[0,0],[127,0],[127,127],[0,127]],np.float32)
        transform=cv2.getPerspectiveTransform(points,square)
        crop=cv2.warpPerspective(gray,transform,(self.size,self.size)).astype(np.float32)/255.
        return points,square,transform,crop,edge

    def seed(self,gray,corners,at,modules=None):
        try:
            _,_,_,crop,edge=self._quad(gray,corners)
            if modules is None:return
            modules=np.asarray(modules)
            if (modules.ndim!=2 or modules.shape[0]!=modules.shape[1]
                    or not 21<=modules.shape[0]<=177 or (modules.shape[0]-21)%4):return
            self.modules=modules>127
            # Rectified, binarized modules from the successful exact decode
            # avoid baking photographic blur into future identity checks.
            self.reference=cv2.resize(modules,(128,128),interpolation=cv2.INTER_NEAREST).astype(np.float32)/255.
            self.decoded_at=self.visual_at=at
        except (ValueError,cv2.error):return

    def match(self,gray,candidates,at):
        if self.reference is None:return None
        if not (0<=at-self.decoded_at<=self.max_decode_age and 0<=at-self.visual_at<=self.max_visual_gap):
            self.clear();return None
        for candidate in candidates:
            try:
                points,square,transform,crop,edge=self._quad(gray,candidate)
                # Compare at the observed sampling resolution, rather than
                # demanding high-frequency cells absent from a 50-pixel QR.
                reference=cv2.GaussianBlur(self.reference,(0,0),max(.6,128/edge*.6))
                current=cv2.GaussianBlur(crop,(0,0),.6)
                score,warp=cv2.findTransformECC(reference,current,np.eye(3,dtype=np.float32),
                    cv2.MOTION_HOMOGRAPHY,(cv2.TERM_CRITERIA_COUNT|cv2.TERM_CRITERIA_EPS,60,.0001),None,1)
                if not np.isfinite(warp).all() or score<.85:continue
                refined=cv2.perspectiveTransform(square[None],np.linalg.inv(transform)@warp)[0]
                if np.max(np.linalg.norm(refined-points,axis=1))>max(2.,edge*.12):continue
                self._quad(gray,refined)
                aligned=cv2.warpPerspective(current,warp,(128,128),flags=cv2.INTER_LINEAR|cv2.WARP_INVERSE_MAP)
                # Finder patterns are common to unrelated QR codes. Exclude
                # them from independent identity validation of the data cells.
                mask=np.zeros((128,128),bool);mask[5:123,5:123]=True
                mask[:43,:43]=False;mask[:43,85:]=False;mask[85:,:43]=False
                data_score=self.correlation(reference[mask],aligned[mask])
                quadrants=[self.correlation(reference[y:y+54,x:x+54],aligned[y:y+54,x:x+54])
                           for y in (7,67) for x in (7,67)]
                if (data_score<.65 or min(quadrants)<.4 or aligned[mask].std()<.06):continue
                # Similar EW1 payloads share much of their appearance. Reject
                # confident data-cell contradictions, beyond a global image
                # correlation that could otherwise accept another QR payload.
                n=self.modules.shape[0]
                coords=((np.arange(n)+.5)*128/n).astype(np.float32)
                xx,yy=np.meshgrid(coords,coords)
                samples=cv2.remap(aligned,xx,yy,cv2.INTER_LINEAR)
                low,high=np.percentile(aligned[5:-5,5:-5],[10,90])
                if high-low<.15:continue
                samples=np.clip((samples-low)/(high-low),0,1)
                data=np.ones((n,n),bool)
                data[:9,:9]=False;data[:9,-9:]=False;data[-9:,:9]=False
                confident=(np.abs(samples-.5)>.3)&data
                coverage=float(confident.sum()/data.sum())
                mismatch=float(np.mean((samples[confident]>.5)!=self.modules[confident])) if confident.any() else 1.
                if coverage<.55 or mismatch>.055:continue
                self.visual_at=at
                return {'corners':refined,'score':float(score),'data_score':data_score,
                        'decoded_at':self.decoded_at,'module_error':mismatch,'module_coverage':coverage}
            except (ValueError,cv2.error,np.linalg.LinAlgError):continue
        return None
